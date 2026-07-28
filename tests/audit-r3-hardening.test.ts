// Regression tests for the 2026-07-25 audit's wren-mcp items M2, M3, M4.
// (M1 — the cross-process TOCTOU with the Wren app — is deferred pending a
// locking design decision and is deliberately NOT addressed here.)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadIndex, readNoteByWrenId, NoteNotFoundError } from '../src/notes-source.js';
import { serializeNoteFile, buildNoteFilename } from '../src/note-writer.js';
import { softDeleteNote, loadNote, TRASH_DIR } from '../src/note-editor.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wren-mcp-r3-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeNoteFile(rel: string, wrenId: string, title: string, body: string) {
  const text = serializeNoteFile({
    wrenId,
    title,
    createdIso: '2026-07-01T00:00:00.000Z',
    modifiedIso: '2026-07-01T00:00:00.000Z',
    body,
  });
  await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await fs.writeFile(path.join(dir, rel), text, 'utf8');
}

describe('softDeleteNote never clobbers an existing trash file (M2)', () => {
  it('moves to a distinct name when the trash already holds that filename', async () => {
    // Two different notes that happen to share a filename — the exact case the
    // old check-then-rename could destroy, because POSIX rename REPLACES the
    // destination.
    await writeNoteFile('Shopping.md', 'wren-aaaaaaaaaaaa', 'Shopping', 'first note');
    await fs.mkdir(path.join(dir, TRASH_DIR), { recursive: true });
    await fs.writeFile(path.join(dir, TRASH_DIR, 'Shopping.md'), 'PRE-EXISTING TRASH', 'utf8');

    const catalog = await loadIndex(dir);
    const res = await softDeleteNote(dir, catalog, 'wren-aaaaaaaaaaaa');

    // The pre-existing trash file is untouched...
    const survived = await fs.readFile(path.join(dir, TRASH_DIR, 'Shopping.md'), 'utf8');
    expect(survived).toBe('PRE-EXISTING TRASH');
    // ...and the deleted note landed somewhere else, intact.
    expect(res.trashedPath).not.toBe(`${TRASH_DIR}/Shopping.md`);
    const moved = await fs.readFile(path.join(dir, res.trashedPath), 'utf8');
    expect(moved).toContain('first note');
    // The original is gone from the corpus.
    await expect(fs.access(path.join(dir, 'Shopping.md'))).rejects.toThrow();
  });

  it('uses the wrenId to disambiguate, so the name is predictable', async () => {
    await writeNoteFile('Shopping.md', 'wren-bbbbbbbbbbbb', 'Shopping', 'body');
    await fs.mkdir(path.join(dir, TRASH_DIR), { recursive: true });
    await fs.writeFile(path.join(dir, TRASH_DIR, 'Shopping.md'), 'taken', 'utf8');

    const catalog = await loadIndex(dir);
    const res = await softDeleteNote(dir, catalog, 'wren-bbbbbbbbbbbb');
    expect(res.trashedPath).toBe(`${TRASH_DIR}/Shopping (wren-bbbbbbbbbbbb).md`);
  });

  it('survives repeated collisions without overwriting anything', async () => {
    await fs.mkdir(path.join(dir, TRASH_DIR), { recursive: true });
    await fs.writeFile(path.join(dir, TRASH_DIR, 'Dup.md'), 'taken-0', 'utf8');
    await fs.writeFile(path.join(dir, TRASH_DIR, 'Dup (wren-cccccccccccc).md'), 'taken-1', 'utf8');

    await writeNoteFile('Dup.md', 'wren-cccccccccccc', 'Dup', 'the real note');
    const catalog = await loadIndex(dir);
    const res = await softDeleteNote(dir, catalog, 'wren-cccccccccccc');

    expect(res.trashedPath).toBe(`${TRASH_DIR}/Dup (wren-cccccccccccc-2).md`);
    expect(await fs.readFile(path.join(dir, TRASH_DIR, 'Dup.md'), 'utf8')).toBe('taken-0');
    expect(
      await fs.readFile(path.join(dir, TRASH_DIR, 'Dup (wren-cccccccccccc).md'), 'utf8')
    ).toBe('taken-1');
    expect(await fs.readFile(path.join(dir, res.trashedPath), 'utf8')).toContain('the real note');
  });

  it('still uses the plain filename when the trash is free', async () => {
    await writeNoteFile('Solo.md', 'wren-dddddddddddd', 'Solo', 'body');
    const catalog = await loadIndex(dir);
    const res = await softDeleteNote(dir, catalog, 'wren-dddddddddddd');
    expect(res.trashedPath).toBe(`${TRASH_DIR}/Solo.md`);
  });
});

describe('Filename sanitizer strips DEL and C1 controls (M3)', () => {
  // Same class the sanitizer uses, asserted independently of it.
  // eslint-disable-next-line no-control-regex
  const CTRL = /[\x00-\x1F\x7F-\x9F]/;

  it('removes C0, DEL and C1 control characters from the title', () => {
    const dirty = [
      'Nul',
      String.fromCharCode(0x00),
      'Unit',
      String.fromCharCode(0x1f),
      'Del',
      String.fromCharCode(0x7f),
      'C1',
      String.fromCharCode(0x85),
      String.fromCharCode(0x9f),
      'end',
    ].join('');
    const name = buildNoteFilename('2026-07-01T00:00:00.000Z', dirty);
    // Before the fix, 0x7F and 0x80-0x9F survived into the filename: legal in a
    // UTF-8 title, garbage in a file name, and rejected outright by some sync
    // clients.
    expect(CTRL.test(name)).toBe(false);
    expect(name.endsWith('.md')).toBe(true);
    expect(name.startsWith('2026-07-01 - ')).toBe(true);
    expect(name).toContain('Nul');
    expect(name).toContain('end');
  });

  it('leaves ordinary non-ASCII text alone', () => {
    const name = buildNoteFilename('2026-07-01T00:00:00.000Z', 'Café — naïve résumé');
    expect(name).toContain('Café');
    expect(name).toContain('naïve');
    expect(CTRL.test(name)).toBe(false);
  });
});

describe('Notes with no frontmatter id (M4)', () => {
  it('are skipped by the folder scan instead of collapsing to wrenId ""', async () => {
    // Two id-less notes: under the old behaviour both normalized to wrenId '',
    // making the second unreachable and the first reachable by an empty id.
    await fs.writeFile(
      path.join(dir, 'no-id-one.md'),
      '---\ntitle: One\n---\n\nfirst\n',
      'utf8'
    );
    await fs.writeFile(
      path.join(dir, 'no-id-two.md'),
      '---\ntitle: Two\n---\n\nsecond\n',
      'utf8'
    );
    await writeNoteFile('good.md', 'wren-eeeeeeeeeeee', 'Good', 'real note');

    const catalog = await loadIndex(dir);
    const ids = catalog.notes.map((n) => n.wrenId);
    expect(ids).toContain('wren-eeeeeeeeeeee');
    expect(ids).not.toContain('');
    expect(catalog.notes).toHaveLength(1);
  });

  it("readNoteByWrenId('') rejects early rather than matching an entry", async () => {
    await writeNoteFile('good.md', 'wren-ffffffffffff', 'Good', 'real note');
    const catalog = await loadIndex(dir);
    // Force an id-less row into the catalog the way a hand-edited or truncated
    // .wren-index.json could.
    catalog.notes.push({ ...catalog.notes[0], wrenId: '', path: 'good.md', file: 'good.md' });

    await expect(readNoteByWrenId(dir, catalog, '')).rejects.toBeInstanceOf(NoteNotFoundError);
    await expect(readNoteByWrenId(dir, catalog, '   ')).rejects.toBeInstanceOf(NoteNotFoundError);
    // The write path shares the same guard.
    await expect(loadNote(dir, catalog, '')).rejects.toBeInstanceOf(NoteNotFoundError);
    // A real id still resolves.
    const ok = await readNoteByWrenId(dir, catalog, 'wren-ffffffffffff');
    expect(ok.body).toContain('real note');
  });
});
