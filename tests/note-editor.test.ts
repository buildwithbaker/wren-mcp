// Tests for the v2 write layer (src/note-editor.ts): update / append / set_tags
// with the read-first + expected_content_hash optimistic-concurrency gate, the
// dry_run diff path, soft-delete to .trash/, move-to-corpus, namespaced-tag
// validation, and path-traversal safety. Runs against real temp folders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadIndex,
  readNoteByWrenId,
  parseFrontmatter,
  bodyContentHash,
  type Catalog,
} from '../src/notes-source.js';
import { serializeNoteFile, createNote } from '../src/note-writer.js';
import {
  updateNote,
  appendToNote,
  setTags,
  softDeleteNote,
  moveToCorpus,
  applyTagChanges,
  joinAppended,
  lineDiff,
  loadNote,
  WriteConflictError,
  InvalidTagError,
  NotAnInboxNoteError,
  TRASH_DIR,
} from '../src/note-editor.js';
import { NoteNotFoundError } from '../src/notes-source.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wren-mcp-edit-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

interface SeedOpts {
  wrenId: string;
  title?: string;
  body?: string;
  created?: string;
  modified?: string;
  color?: string;
  due?: string;
  summary?: string;
  tags?: string[];
  fileName?: string;
}

// Write a real note file into the corpus root; returns its relative filename.
async function seed(opts: SeedOpts): Promise<string> {
  const created = opts.created ?? '2026-06-01T10:00:00.000Z';
  const text = serializeNoteFile({
    wrenId: opts.wrenId,
    title: opts.title ?? 'Note',
    createdIso: created,
    modifiedIso: opts.modified ?? created,
    color: opts.color ?? 'default',
    body: opts.body ?? 'original body',
    due: opts.due,
    summary: opts.summary,
    tags: opts.tags,
  });
  const name = opts.fileName ?? `${created.slice(0, 10)} - ${opts.title ?? 'Note'}.md`;
  await fs.writeFile(path.join(dir, name), text, 'utf8');
  return name;
}

const NOW = '2026-06-15T12:00:00.000Z';

describe('updateNote', () => {
  it('patches the body, bumps modified, preserves color/summary/tags', async () => {
    await seed({
      wrenId: 'wren-aaaaaaaaaaaa',
      title: 'Keep',
      body: 'old body',
      color: 'amber',
      summary: 'a summary',
      tags: ['status:todo'],
    });
    const catalog = await loadIndex(dir);
    const hash = bodyContentHash('old body');

    const res = await updateNote(
      dir,
      catalog,
      { wrenId: 'wren-aaaaaaaaaaaa', body: 'new body', expectedContentHash: hash },
      NOW
    );
    expect('written' in res && res.written).toBe(true);

    const onDisk = await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8');
    const { frontmatter, body } = parseFrontmatter(onDisk);
    expect(body.trim()).toBe('new body');
    expect(frontmatter.color).toBe('amber'); // preserved
    expect(frontmatter.summary).toBe('a summary'); // preserved
    expect(frontmatter.tags).toEqual(['status:todo']); // preserved
    expect(frontmatter.modified).toBe(NOW); // bumped
    expect(frontmatter.created).toBe('2026-06-01T10:00:00.000Z'); // preserved
  });

  it('updates title and due without touching the body', async () => {
    await seed({ wrenId: 'wren-bbbbbbbbbbbb', title: 'Old', body: 'keep me', due: '2026-06-10' });
    const catalog = await loadIndex(dir);
    const res = await updateNote(
      dir,
      catalog,
      {
        wrenId: 'wren-bbbbbbbbbbbb',
        title: 'New Title',
        due: '2026-12-31',
        expectedContentHash: bodyContentHash('keep me'),
      },
      NOW
    );
    expect('written' in res).toBe(true);
    const { frontmatter, body } = parseFrontmatter(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8'));
    expect(frontmatter.title).toBe('New Title');
    expect(frontmatter.due).toBe('2026-12-31');
    expect(body.trim()).toBe('keep me');
  });

  it('REJECTS a stale write (conflict) and does not modify the file', async () => {
    await seed({ wrenId: 'wren-cccccccccccc', body: 'current body' });
    const catalog = await loadIndex(dir);
    const before = await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8');

    await expect(
      updateNote(
        dir,
        catalog,
        { wrenId: 'wren-cccccccccccc', body: 'attempted', expectedContentHash: bodyContentHash('STALE') },
        NOW
      )
    ).rejects.toThrow(WriteConflictError);

    // File untouched.
    expect(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8')).toBe(before);
  });

  it('dry_run returns a diff and writes nothing', async () => {
    await seed({ wrenId: 'wren-dddddddddddd', body: 'line1\nline2' });
    const catalog = await loadIndex(dir);
    const before = await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8');

    const res = await updateNote(
      dir,
      catalog,
      { wrenId: 'wren-dddddddddddd', body: 'line1\nCHANGED', expectedContentHash: bodyContentHash('line1\nline2'), dryRun: true },
      NOW
    );
    expect('dryRun' in res && res.dryRun).toBe(true);
    if ('dryRun' in res) {
      expect(res.bodyDiff).toContain('- line2');
      expect(res.bodyDiff).toContain('+ CHANGED');
      expect(res.contentHashAfter).toBe(bodyContentHash('line1\nCHANGED'));
    }
    // Nothing written.
    expect(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8')).toBe(before);
  });

  it('returns a fresh contentHash usable for a chained edit', async () => {
    await seed({ wrenId: 'wren-eeeeeeeeeeee', body: 'v1' });
    const catalog = await loadIndex(dir);
    const r1 = await updateNote(dir, catalog, { wrenId: 'wren-eeeeeeeeeeee', body: 'v2', expectedContentHash: bodyContentHash('v1') }, NOW);
    expect('contentHash' in r1).toBe(true);
    if ('contentHash' in r1) {
      // The returned hash matches the new body and gates the next write.
      const catalog2 = await loadIndex(dir);
      const r2 = await updateNote(dir, catalog2, { wrenId: 'wren-eeeeeeeeeeee', body: 'v3', expectedContentHash: r1.contentHash }, NOW);
      expect('written' in r2).toBe(true);
    }
  });
});

describe('appendToNote', () => {
  it('appends after a blank line and gates on the hash', async () => {
    await seed({ wrenId: 'wren-ffffffffffff', body: 'first para' });
    const catalog = await loadIndex(dir);
    await appendToNote(dir, catalog, { wrenId: 'wren-ffffffffffff', text: 'second para', expectedContentHash: bodyContentHash('first para') }, NOW);
    const { body } = parseFrontmatter(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8'));
    expect(body.trim()).toBe('first para\n\nsecond para');
  });

  it('rejects a conflicting append', async () => {
    await seed({ wrenId: 'wren-111111111111', body: 'body' });
    const catalog = await loadIndex(dir);
    await expect(
      appendToNote(dir, catalog, { wrenId: 'wren-111111111111', text: 'x', expectedContentHash: 'sha256-wrong' }, NOW)
    ).rejects.toThrow(WriteConflictError);
  });

  it('joinAppended handles an empty body', () => {
    expect(joinAppended('', 'hello')).toBe('hello');
    expect(joinAppended('a\n', 'b')).toBe('a\n\nb');
  });
});

describe('setTags', () => {
  it('adds and removes namespaced tags', async () => {
    await seed({ wrenId: 'wren-222222222222', body: 'b', tags: ['status:todo', 'project:wren'] });
    const catalog = await loadIndex(dir);
    const res = await setTags(
      dir,
      catalog,
      { wrenId: 'wren-222222222222', add: ['priority:high'], remove: ['status:todo'], expectedContentHash: bodyContentHash('b') },
      NOW
    );
    expect('tags' in res && res.tags).toEqual(['project:wren', 'priority:high']);
    const { frontmatter } = parseFrontmatter(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8'));
    expect(frontmatter.tags).toEqual(['project:wren', 'priority:high']);
  });

  it('REJECTS an invalid (bare, un-namespaced) tag and writes nothing', async () => {
    await seed({ wrenId: 'wren-333333333333', body: 'b', tags: ['status:todo'] });
    const catalog = await loadIndex(dir);
    const before = await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8');
    await expect(
      setTags(dir, catalog, { wrenId: 'wren-333333333333', add: ['important'], expectedContentHash: bodyContentHash('b') }, NOW)
    ).rejects.toThrow(InvalidTagError);
    expect(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8')).toBe(before);
  });

  it('rejects a conflicting set_tags', async () => {
    await seed({ wrenId: 'wren-444444444444', body: 'b' });
    const catalog = await loadIndex(dir);
    await expect(
      setTags(dir, catalog, { wrenId: 'wren-444444444444', add: ['a:b'], expectedContentHash: 'sha256-stale' }, NOW)
    ).rejects.toThrow(WriteConflictError);
  });

  it('applyTagChanges dedupes and preserves order', () => {
    expect(applyTagChanges(['a:1', 'b:2'], ['c:3', 'a:1'], ['b:2'])).toEqual(['a:1', 'c:3']);
  });
});

describe('softDeleteNote', () => {
  it('moves the note into .trash/ — original gone, copy recoverable', async () => {
    const name = await seed({ wrenId: 'wren-555555555555', title: 'Doomed', body: 'save me' });
    const catalog = await loadIndex(dir);
    const res = await softDeleteNote(dir, catalog, 'wren-555555555555');

    expect(res.softDeleted).toBe(true);
    expect(res.trashedPath.startsWith(`${TRASH_DIR}/`)).toBe(true);
    // Original removed from the corpus.
    await expect(fs.access(path.join(dir, name))).rejects.toThrow();
    // Recoverable copy in .trash/ with the content intact.
    const trashed = await fs.readFile(path.join(dir, res.trashedPath), 'utf8');
    expect(trashed).toContain('save me');
  });

  it('collision-suffixes a second trashed note of the same filename', async () => {
    await seed({ wrenId: 'wren-666666666666', title: 'Dup', body: 'one', fileName: 'Dup.md' });
    let catalog = await loadIndex(dir);
    const r1 = await softDeleteNote(dir, catalog, 'wren-666666666666');
    await seed({ wrenId: 'wren-777777777777', title: 'Dup', body: 'two', fileName: 'Dup.md' });
    catalog = await loadIndex(dir);
    const r2 = await softDeleteNote(dir, catalog, 'wren-777777777777');
    expect(r1.trashedPath).not.toBe(r2.trashedPath);
  });

  it('the .trash/ folder is NOT picked up as notes by the catalog', async () => {
    await seed({ wrenId: 'wren-888888888888', title: 'Gone', body: 'x' });
    const catalog = await loadIndex(dir);
    await softDeleteNote(dir, catalog, 'wren-888888888888');
    const after = await loadIndex(dir);
    expect(after.notes.find((n) => n.wrenId === 'wren-888888888888')).toBeUndefined();
    expect(after.notes.length).toBe(0);
  });
});

describe('moveToCorpus', () => {
  it('promotes an _inbox/ note to the root and removes the inbox original', async () => {
    const created = await createNote(dir, { title: 'Staged', body: 'promote me', target: 'inbox' }, '2026-06-02T00:00:00.000Z');
    expect(created.path.startsWith('_inbox/')).toBe(true);
    const catalog = await loadIndex(dir);
    const res = await moveToCorpus(dir, catalog, created.wrenId);

    expect(res.target).toBe('corpus');
    expect(res.path).not.toContain('_inbox/');
    await expect(fs.access(path.join(dir, created.path))).rejects.toThrow(); // inbox original gone
    const moved = await fs.readFile(path.join(dir, res.path), 'utf8');
    expect(moved).toContain('promote me');
  });

  it('errors when the note is not a staged _inbox/ note', async () => {
    await seed({ wrenId: 'wren-999999999999', body: 'corpus note' });
    const catalog = await loadIndex(dir);
    await expect(moveToCorpus(dir, catalog, 'wren-999999999999')).rejects.toThrow(NotAnInboxNoteError);
  });
});

describe('provenance (v2.1)', () => {
  it('update on a human-authored note stamps created_by=human, last_edited_by=ai, last_edited', async () => {
    await seed({ wrenId: 'wren-prov00000001', body: 'b' }); // seeded with no provenance = human note
    const catalog = await loadIndex(dir);
    await updateNote(dir, catalog, { wrenId: 'wren-prov00000001', body: 'b2', expectedContentHash: bodyContentHash('b') }, NOW);
    const { frontmatter } = parseFrontmatter(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8'));
    expect(frontmatter.created_by).toBe('human'); // absent before → defaults to human
    expect(frontmatter.last_edited_by).toBe('ai');
    expect(frontmatter.last_edited).toBe(NOW);
  });

  it('never clobbers an existing created_by=ai on update', async () => {
    const created = await createNote(dir, { title: 'AI note', body: 'v1', target: 'corpus' }, '2026-06-01T00:00:00.000Z');
    const catalog = await loadIndex(dir);
    const read = await readNoteByWrenId(dir, catalog, created.wrenId);
    expect((read.frontmatter as Record<string, unknown>).created_by).toBe('ai'); // stamped at create
    await updateNote(dir, catalog, { wrenId: created.wrenId, body: 'v2', expectedContentHash: read.contentHash }, NOW);
    const { frontmatter } = parseFrontmatter(await fs.readFile(path.join(dir, created.path), 'utf8'));
    expect(frontmatter.created_by).toBe('ai'); // preserved, not clobbered
    expect(frontmatter.last_edited_by).toBe('ai');
    expect(frontmatter.last_edited).toBe(NOW);
  });

  it('append and set_tags also stamp ai last_edited provenance', async () => {
    await seed({ wrenId: 'wren-prov00000002', body: 'b' });
    let catalog = await loadIndex(dir);
    await appendToNote(dir, catalog, { wrenId: 'wren-prov00000002', text: 'more', expectedContentHash: bodyContentHash('b') }, NOW);
    let fm = parseFrontmatter(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8')).frontmatter;
    expect(fm.last_edited_by).toBe('ai');
    expect(fm.created_by).toBe('human');

    catalog = await loadIndex(dir);
    const read = await readNoteByWrenId(dir, catalog, 'wren-prov00000002');
    await setTags(dir, catalog, { wrenId: 'wren-prov00000002', add: ['status:todo'], expectedContentHash: read.contentHash }, NOW);
    fm = parseFrontmatter(await fs.readFile(path.join(dir, await firstMd(dir)), 'utf8')).frontmatter;
    expect(fm.last_edited_by).toBe('ai');
    expect(fm.last_edited).toBe(NOW);
  });
});

describe('safety', () => {
  it('loadNote rejects a path-traversal entry', async () => {
    const evil: Catalog = {
      schemaVersion: 1,
      generatedAt: NOW,
      backend: 'fs',
      count: 1,
      notes: [
        {
          wrenId: 'wren-evil00000000',
          storageId: '../evil.md',
          path: '../evil.md',
          file: 'evil.md',
          title: 'Evil',
          summary: '',
          due: '',
          tags: [],
          color: 'default',
          created: NOW,
          updated: NOW,
          contentHash: 'sha256-x',
        },
      ],
    };
    await expect(loadNote(dir, evil, 'wren-evil00000000')).rejects.toThrow(/outside the notes folder/);
  });

  it('loadNote throws NoteNotFoundError for an unknown id', async () => {
    const catalog = await loadIndex(dir);
    await expect(loadNote(dir, catalog, 'wren-nope00000000')).rejects.toThrow(NoteNotFoundError);
  });

  it('readNoteByWrenId surfaces the contentHash the write tools expect', async () => {
    await seed({ wrenId: 'wren-hashcheck000', body: 'hash me' });
    const catalog = await loadIndex(dir);
    const read = await readNoteByWrenId(dir, catalog, 'wren-hashcheck000');
    expect(read.contentHash).toBe(bodyContentHash('hash me'));
  });
});

describe('lineDiff', () => {
  it('returns empty for identical input', () => {
    expect(lineDiff('a\nb', 'a\nb')).toBe('');
  });
  it('shows removed and added middle lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nX\nc')).toBe('- b\n+ X');
  });
});

// Find the single .md note file in the corpus root (helper for assertions).
async function firstMd(d: string): Promise<string> {
  const entries = await fs.readdir(d, { withFileTypes: true });
  const md = entries.find((e) => e.isFile() && e.name.endsWith('.md'));
  if (!md) throw new Error('no .md file found');
  return md.name;
}
