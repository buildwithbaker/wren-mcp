// Regression tests for audit M1 — the cross-process race with the Wren app.
//
// There is deliberately no lock (the app writes through the browser File
// System Access API, which has no exclusive-create primitive, so a lock only
// this process honors would not stop the app while adding stale-lock and
// stray-file failure modes — see the commitWrite() docblock). What IS testable,
// and what these cover, is that the concurrency gate now runs at the LAST
// possible moment instead of at load time:
//
//   before: loadNote() hashed -> serialize -> write temp -> rename
//           (a concurrent save anywhere in that stretch was silently clobbered)
//   after:  loadNote() hashed -> serialize -> write temp -> RE-CHECK -> rename
//
// Simulating that correctly is the whole trick. Writing to the file BEFORE
// calling updateNote proves nothing: updateNote re-reads and re-hashes on entry,
// so the pre-existing gate catches it and the test passes even with the fix
// reverted (confirmed — the first draft of this file did exactly that). The
// concurrent save has to land INSIDE the window: after updateNote's own
// loadNote and serialization, before its rename. duringTempWrite() gets there
// by hooking fs.writeFile and performing the app's save at the moment the temp
// file is written, which is the last step before the rename.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
// The exact parameter tuple of fs.promises.writeFile — spelled out so the
// spies below type-check against the real overload instead of `any`.
type WriteFileArgs = Parameters<typeof fs.writeFile>;
import os from 'node:os';
import path from 'node:path';
import { loadIndex } from '../src/notes-source.js';
import { serializeNoteFile } from '../src/note-writer.js';
import {
  updateNote,
  appendToNote,
  setTags,
  loadNote,
  WriteConflictError,
} from '../src/note-editor.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wren-mcp-m1-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const WREN_ID = 'wren-raceracerac';

async function seedNote(body = 'original body') {
  const text = serializeNoteFile({
    wrenId: WREN_ID,
    title: 'Race',
    createdIso: '2026-07-01T00:00:00.000Z',
    modifiedIso: '2026-07-01T00:00:00.000Z',
    body,
  });
  await fs.writeFile(path.join(dir, 'Race.md'), text, 'utf8');
  return loadIndex(dir);
}

async function currentBody() {
  const raw = await fs.readFile(path.join(dir, 'Race.md'), 'utf8');
  return raw.split('---').slice(2).join('---').trim();
}

async function strayFiles() {
  return (await fs.readdir(dir)).filter((f) => f.includes('tmp'));
}

/**
 * Run `fn` with the Wren app saving `body` from "the other process" at the
 * exact moment the MCP writes its temp file — i.e. inside the read-to-rename
 * window that audit M1 is about.
 *
 * Returns the temp paths the commit path used, so a test can also assert they
 * are unique per write.
 */
async function duringTempWrite<T>(body: string, fn: () => Promise<T>) {
  const realWriteFile = fs.writeFile.bind(fs);
  const tempPaths: string[] = [];
  const spy = vi
    .spyOn(fs, 'writeFile')
    .mockImplementation(async (...args: WriteFileArgs) => {
      const [target, , ] = args;
      const result = await realWriteFile(...args);
      if (String(target).includes('wren-mcp.tmp')) {
        tempPaths.push(String(target));
        // The human hits save in Wren, right now. realWriteFile, not fs.writeFile,
        // so this doesn't recurse back into the hook.
        const text = serializeNoteFile({
          wrenId: WREN_ID,
          title: 'Race',
          createdIso: '2026-07-01T00:00:00.000Z',
          modifiedIso: '2026-07-05T00:00:00.000Z',
          body,
        });
        await realWriteFile(path.join(dir, 'Race.md'), text, 'utf8');
      }
      return result;
    });
  try {
    const outcome = await fn().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );
    return { outcome, tempPaths };
  } finally {
    spy.mockRestore();
  }
}

describe('A concurrent save is detected at commit time, not clobbered (M1)', () => {
  it('updateNote refuses to overwrite a save that lands inside the window', async () => {
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);

    const { outcome } = await duringTempWrite('the human typed this', () =>
      updateNote(dir, catalog, {
        wrenId: WREN_ID,
        body: 'the assistant wrote this',
        expectedContentHash: note.contentHash,
      })
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.error).toBeInstanceOf(WriteConflictError);
    // The human's save survives, byte for byte. Under the old ordering the
    // rename landed on top of it and this read 'the assistant wrote this'.
    expect(await currentBody()).toBe('the human typed this');
  });

  it('appendToNote refuses too', async () => {
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);

    const { outcome } = await duringTempWrite('the human typed this', () =>
      appendToNote(dir, catalog, {
        wrenId: WREN_ID,
        text: 'appended by the assistant',
        expectedContentHash: note.contentHash,
      })
    );

    expect(outcome.ok === false && outcome.error).toBeInstanceOf(WriteConflictError);
    expect(await currentBody()).toBe('the human typed this');
  });

  it('setTags refuses too', async () => {
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);

    const { outcome } = await duringTempWrite('the human typed this', () =>
      setTags(dir, catalog, {
        wrenId: WREN_ID,
        add: ['status:done'],
        expectedContentHash: note.contentHash,
      })
    );

    expect(outcome.ok === false && outcome.error).toBeInstanceOf(WriteConflictError);
    expect(await currentBody()).toBe('the human typed this');
  });

  it('reports the LIVE hash in the conflict, so a retry can succeed', async () => {
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);

    const { outcome } = await duringTempWrite('the human typed this', () =>
      updateNote(dir, catalog, {
        wrenId: WREN_ID,
        body: 'assistant',
        expectedContentHash: note.contentHash,
      })
    );

    const err = (outcome.ok === false ? outcome.error : null) as WriteConflictError;
    expect(err).toBeInstanceOf(WriteConflictError);
    expect(err.expected).toBe(note.contentHash);
    // Not the stale hash echoed back — the value actually on disk now, which is
    // what the caller needs to retry against.
    expect(err.actual).not.toBe(note.contentHash);
    const fresh = await loadNote(dir, catalog, WREN_ID);
    expect(err.actual).toBe(fresh.contentHash);
  });

  it('never resurrects a note deleted mid-write', async () => {
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);
    // The user deletes the note in the app while the MCP holds a stale read.
    // Renaming the temp file onto the target would bring it back from the dead.
    await fs.rm(path.join(dir, 'Race.md'));

    await expect(
      updateNote(dir, catalog, {
        wrenId: WREN_ID,
        body: 'assistant',
        expectedContentHash: note.contentHash,
      })
    ).rejects.toThrow();
    // The invariant that matters: still deleted, and no scratch file left over.
    await expect(fs.access(path.join(dir, 'Race.md'))).rejects.toThrow();
    expect(await strayFiles()).toEqual([]);
    // NOTE: in this ordering updateNote's own loadNote() hits the missing file
    // first, so the rejection comes from there rather than from commitWrite's
    // ENOENT branch. That branch covers the narrower case where the delete
    // lands after loadNote and before the rename — real, but not reachable
    // deterministically from a black-box test, so it is defensive code with a
    // documented reason rather than a covered line.
  });
});

describe('The commit path leaves no scratch files behind (M1)', () => {
  it('cleans up the temp file when the write succeeds', async () => {
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);
    await updateNote(dir, catalog, {
      wrenId: WREN_ID,
      body: 'new body',
      expectedContentHash: note.contentHash,
    });
    expect(await currentBody()).toContain('new body');
    expect(await strayFiles()).toEqual([]);
  });

  it('cleans up the temp file when the write is rejected', async () => {
    // A .tmp left in the notes folder syncs to Drive and shows up in the user's
    // file manager — the old fixed-name temp was never removed on failure.
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);

    const { outcome } = await duringTempWrite('the human typed this', () =>
      updateNote(dir, catalog, {
        wrenId: WREN_ID,
        body: 'assistant',
        expectedContentHash: note.contentHash,
      })
    );

    expect(outcome.ok === false && outcome.error).toBeInstanceOf(WriteConflictError);
    expect(await strayFiles()).toEqual([]);
  });

  it('gives each write its own temp file, so concurrent writes cannot interleave', async () => {
    // The old fixed `.wren-mcp.tmp` name was shared by every write, so two
    // in-flight writes to the same note interleaved into one scratch file.
    const catalog = await seedNote();
    const a = await loadNote(dir, catalog, WREN_ID);

    // Capture the temp paths two back-to-back writes actually use.
    const realWriteFile = fs.writeFile.bind(fs);
    const tempPaths: string[] = [];
    const spy = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation(async (...args: WriteFileArgs) => {
        if (String(args[0]).includes('wren-mcp.tmp')) tempPaths.push(String(args[0]));
        return realWriteFile(...args);
      });

    try {
      await updateNote(dir, catalog, {
        wrenId: WREN_ID,
        body: 'writer A',
        expectedContentHash: a.contentHash,
      });
      const b = await loadNote(dir, catalog, WREN_ID);
      await updateNote(dir, catalog, {
        wrenId: WREN_ID,
        body: 'writer B',
        expectedContentHash: b.contentHash,
      });
    } finally {
      spy.mockRestore();
    }

    expect(tempPaths).toHaveLength(2);
    // The old fixed name meant these were the same path for every write in the
    // process, so two in-flight writes shared one scratch file.
    expect(new Set(tempPaths).size).toBe(2);
    expect(await currentBody()).toBe('writer B');
    expect(await strayFiles()).toEqual([]);
  });
});

describe('Normal writes are unaffected (M1 regression guard)', () => {
  it('still writes when nothing else touched the note', async () => {
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);
    const res = await updateNote(dir, catalog, {
      wrenId: WREN_ID,
      body: 'quiet update',
      expectedContentHash: note.contentHash,
    });
    expect(res).toBeTruthy();
    expect(await currentBody()).toBe('quiet update');
  });

  it('dry_run still touches nothing', async () => {
    const catalog = await seedNote();
    const note = await loadNote(dir, catalog, WREN_ID);
    await updateNote(dir, catalog, {
      wrenId: WREN_ID,
      body: 'not written',
      expectedContentHash: note.contentHash,
      dryRun: true,
    });
    expect(await currentBody()).toBe('original body');
    expect(await strayFiles()).toEqual([]);
  });
});
