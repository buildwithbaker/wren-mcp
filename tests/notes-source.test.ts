// Tests for the read layer (src/notes-source.ts) against real temp folders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadIndex,
  scanFolderCatalog,
  searchNotes,
  listNotes,
  readNoteByWrenId,
  getIndexSummary,
  parseFrontmatter,
  NoteNotFoundError,
  INDEX_SUMMARY_THRESHOLD,
  type Catalog,
  type NoteEntry,
} from '../src/notes-source.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wren-mcp-test-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function noteFile(fm: Record<string, string | string[]>, body: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'tags' && Array.isArray(v)) lines.push(`tags: ${JSON.stringify(v)}`);
    else if (k === 'title' || k === 'summary' || k === 'due') lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', body);
  return lines.join('\n');
}

function entry(over: Partial<NoteEntry>): NoteEntry {
  return {
    wrenId: 'wren-000000000000',
    storageId: 'n.md',
    path: 'n.md',
    file: 'n.md',
    title: '',
    summary: '',
    due: '',
    tags: [],
    color: 'default',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    contentHash: 'sha256-x',
    ...over,
  };
}

function catalogOf(notes: NoteEntry[]): Catalog {
  return {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    backend: 'fs',
    count: notes.length,
    notes,
  };
}

describe('parseFrontmatter', () => {
  it('parses quoted strings (incl. colons), tags array, and body', () => {
    const text = noteFile(
      { id: 'wren-aaaaaaaaaaaa', title: 'Hello: World', tags: ['status:todo', 'x'] },
      '# Body\ntext'
    );
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter.id).toBe('wren-aaaaaaaaaaaa');
    expect(frontmatter.title).toBe('Hello: World');
    expect(frontmatter.tags).toEqual(['status:todo', 'x']);
    expect(body).toContain('# Body');
  });
  it('returns the whole text as body when there is no frontmatter', () => {
    const { frontmatter, body } = parseFrontmatter('just text');
    expect(frontmatter).toEqual({});
    expect(body).toBe('just text');
  });
});

describe('loadIndex', () => {
  it('reads a valid .wren-index.json', async () => {
    const cat = catalogOf([entry({ wrenId: 'wren-aaaaaaaaaaaa', title: 'A' })]);
    await fs.writeFile(path.join(dir, '.wren-index.json'), JSON.stringify(cat), 'utf8');
    const loaded = await loadIndex(dir);
    expect(loaded.notes).toHaveLength(1);
    expect(loaded.notes[0].wrenId).toBe('wren-aaaaaaaaaaaa');
    expect(loaded.fromFallback).toBeUndefined();
  });

  it('falls back to a folder scan when the index is absent', async () => {
    await fs.writeFile(
      path.join(dir, 'note.md'),
      noteFile({ id: 'wren-bbbbbbbbbbbb', title: 'Scanned', modified: '2026-02-01T00:00:00.000Z' }, 'body'),
      'utf8'
    );
    // Reserved files are excluded; the _inbox/ note is INCLUDED but flagged.
    await fs.writeFile(path.join(dir, '_index.md'), '# managed', 'utf8');
    await fs.writeFile(path.join(dir, 'README-for-AI.md'), '# contract', 'utf8');
    await fs.mkdir(path.join(dir, '_inbox'));
    await fs.writeFile(path.join(dir, '_inbox', 'staged.md'), noteFile({ id: 'wren-cccccccccccc', title: 'Staged' }, 'b'), 'utf8');

    const loaded = await loadIndex(dir);
    expect(loaded.fromFallback).toBe(true);
    // Main-corpus note present and not flagged.
    const scanned = loaded.notes.find((n) => n.title === 'Scanned');
    expect(scanned).toBeTruthy();
    expect(scanned?.inbox).toBeUndefined();
    expect(scanned?.contentHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    // Reserved files excluded.
    expect(loaded.notes.some((n) => n.title === 'managed' || n.title === 'contract')).toBe(false);
    // Staged note is in the catalog with inbox:true and an _inbox/ path.
    const staged = loaded.notes.find((n) => n.wrenId === 'wren-cccccccccccc');
    expect(staged?.inbox).toBe(true);
    expect(staged?.path).toBe('_inbox/staged.md');
  });

  it('falls back when the index is malformed JSON', async () => {
    await fs.writeFile(path.join(dir, '.wren-index.json'), '{not json', 'utf8');
    await fs.writeFile(path.join(dir, 'note.md'), noteFile({ id: 'wren-dddddddddddd', title: 'X' }, 'b'), 'utf8');
    const loaded = await loadIndex(dir);
    expect(loaded.fromFallback).toBe(true);
    expect(loaded.notes).toHaveLength(1);
  });

  it('best-effort continues on a schemaVersion mismatch', async () => {
    const cat = { ...catalogOf([entry({ wrenId: 'wren-eeeeeeeeeeee' })]), schemaVersion: 999 };
    await fs.writeFile(path.join(dir, '.wren-index.json'), JSON.stringify(cat), 'utf8');
    const loaded = await loadIndex(dir);
    expect(loaded.notes).toHaveLength(1);
  });
});

describe('searchNotes', () => {
  const cat = catalogOf([
    entry({ wrenId: 'wren-1', title: 'Grocery list', summary: 'milk and eggs', tags: ['area:home'], updated: '2026-03-01T00:00:00Z' }),
    entry({ wrenId: 'wren-2', title: 'Project plan', summary: 'roadmap', tags: ['project:wren', 'status:todo'], due: '2026-06-10', updated: '2026-03-02T00:00:00Z' }),
    entry({ wrenId: 'wren-3', title: 'Staged idea', summary: '', inbox: true, updated: '2026-03-03T00:00:00Z' }),
  ]);

  it('matches query against title + summary, case-insensitive', () => {
    expect(searchNotes(cat, { query: 'GROCERY' }).map((h) => h.wrenId)).toEqual(['wren-1']);
    expect(searchNotes(cat, { query: 'roadmap' }).map((h) => h.wrenId)).toEqual(['wren-2']);
  });
  it('filters by exact tag', () => {
    expect(searchNotes(cat, { tag: 'status:todo' }).map((h) => h.wrenId)).toEqual(['wren-2']);
  });
  it('filters by due_before', () => {
    expect(searchNotes(cat, { dueBefore: '2026-06-15' }).map((h) => h.wrenId)).toEqual(['wren-2']);
    expect(searchNotes(cat, { dueBefore: '2026-06-01' })).toHaveLength(0);
  });
  it('excludes inbox notes by default', () => {
    expect(searchNotes(cat, {}).some((h) => h.wrenId === 'wren-3')).toBe(false);
  });
  it('returns metadata only (no body field)', () => {
    const hit = searchNotes(cat, { query: 'grocery' })[0] as Record<string, unknown>;
    expect('body' in hit).toBe(false);
    expect(Object.keys(hit).sort()).toEqual(['due', 'summary', 'tags', 'title', 'updated', 'wrenId'].sort());
  });
  it('clamps limit to the max', () => {
    const many = catalogOf(Array.from({ length: 80 }, (_, i) => entry({ wrenId: `wren-${i}`, title: `n${i}` })));
    expect(searchNotes(many, { limit: 999 })).toHaveLength(50);
    expect(searchNotes(many, {})).toHaveLength(20); // default
  });
});

describe('listNotes pagination', () => {
  const cat = catalogOf(Array.from({ length: 5 }, (_, i) => entry({ wrenId: `wren-${i}`, title: `n${i}` })));

  it('paginates with an opaque cursor', () => {
    const p1 = listNotes(cat, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = listNotes(cat, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(2);
    const p3 = listNotes(cat, { limit: 2, cursor: p2.nextCursor });
    expect(p3.items).toHaveLength(1);
    expect(p3.nextCursor).toBeUndefined(); // last page
    // No overlap across pages.
    const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.wrenId);
    expect(new Set(ids).size).toBe(5);
  });
  it('ignores a malformed cursor (starts from 0)', () => {
    const p = listNotes(cat, { limit: 2, cursor: 'not-base64!!' });
    expect(p.items[0].wrenId).toBe('wren-0');
  });
});

describe('readNoteByWrenId', () => {
  it('reads frontmatter + body for a valid id (not stale when index is current)', async () => {
    // Index `updated` far in the future so the just-written file is NOT newer.
    const cat = catalogOf([
      entry({ wrenId: 'wren-aaaaaaaaaaaa', path: 'a.md', file: 'a.md', title: 'A', updated: '2099-01-01T00:00:00.000Z' }),
    ]);
    await fs.writeFile(path.join(dir, 'a.md'), noteFile({ id: 'wren-aaaaaaaaaaaa', title: 'A' }, 'the body'), 'utf8');
    const note = await readNoteByWrenId(dir, cat, 'wren-aaaaaaaaaaaa');
    expect(note.title).toBe('A');
    expect(note.body.trim()).toBe('the body');
    expect(note.stale).toBe(false);
  });

  it('reads a staged _inbox/ note by wrenId', async () => {
    const cat = catalogOf([
      entry({ wrenId: 'wren-cccccccccccc', path: '_inbox/s.md', file: 's.md', title: 'Staged', inbox: true }),
    ]);
    await fs.mkdir(path.join(dir, '_inbox'));
    await fs.writeFile(path.join(dir, '_inbox', 's.md'), noteFile({ id: 'wren-cccccccccccc', title: 'Staged' }, 'staged body'), 'utf8');
    const note = await readNoteByWrenId(dir, cat, 'wren-cccccccccccc');
    expect(note.body.trim()).toBe('staged body');
  });

  it('throws NoteNotFoundError on an unknown id', async () => {
    const cat = catalogOf([entry({ wrenId: 'wren-aaaaaaaaaaaa' })]);
    await expect(readNoteByWrenId(dir, cat, 'wren-missing00000')).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it('returns the fresh disk copy when the file is newer than the index', async () => {
    const cat = catalogOf([
      entry({ wrenId: 'wren-aaaaaaaaaaaa', path: 'a.md', file: 'a.md', updated: '2020-01-01T00:00:00.000Z' }),
    ]);
    const p = path.join(dir, 'a.md');
    await fs.writeFile(p, noteFile({ id: 'wren-aaaaaaaaaaaa', title: 'Fresh' }, 'fresh content'), 'utf8');
    // mtime is "now" (>> 2020), so it should be flagged stale and re-read.
    const note = await readNoteByWrenId(dir, cat, 'wren-aaaaaaaaaaaa');
    expect(note.stale).toBe(true);
    expect(note.body).toContain('fresh content');
    expect(note.updated > '2020-01-01T00:00:00.000Z').toBe(true);
  });
});

describe('getIndexSummary', () => {
  it('returns full notes under the threshold', () => {
    const cat = catalogOf([entry({ wrenId: 'wren-1', summary: 'keep me', tags: ['a:b'] })]);
    const sum = getIndexSummary(cat);
    expect(sum.summarized).toBeUndefined();
    expect((sum.notes[0] as NoteEntry).summary).toBe('keep me');
  });
  it('summarizes (drops summary/tags) above the threshold', () => {
    const big = catalogOf(
      Array.from({ length: INDEX_SUMMARY_THRESHOLD + 1 }, (_, i) =>
        entry({ wrenId: `wren-${i}`, summary: 'heavy', tags: ['a:b'] })
      )
    );
    const sum = getIndexSummary(big);
    expect(sum.summarized).toBe(true);
    const first = sum.notes[0] as Record<string, unknown>;
    expect('summary' in first).toBe(false);
    expect('tags' in first).toBe(false);
    expect(first.wrenId).toBe('wren-0');
  });
});

describe('scanFolderCatalog', () => {
  it('returns an empty catalog for a nonexistent dir', async () => {
    const cat = await scanFolderCatalog(path.join(dir, 'does-not-exist'));
    expect(cat.count).toBe(0);
    expect(cat.fromFallback).toBe(true);
  });
});
