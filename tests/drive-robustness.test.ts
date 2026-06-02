// Drive-sync (Path A) robustness tests: online-only / 0-byte placeholders,
// read-throws files, and index lag (stale or omitted entries). Real temp folders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadIndex,
  scanFolderCatalog,
  readNoteByWrenId,
  NoteUnreadableError,
  INDEX_FILE,
  type Catalog,
  type NoteEntry,
} from '../src/notes-source.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wren-mcp-drive-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function noteText(fm: Record<string, string | string[]>, body: string): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fm)) {
    if (k === 'tags' && Array.isArray(v)) lines.push(`tags: ${JSON.stringify(v)}`);
    else if (k === 'title' || k === 'summary' || k === 'due') lines.push(`${k}: ${JSON.stringify(v)}`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', body);
  return lines.join('\n');
}

function indexEntry(over: Partial<NoteEntry>): NoteEntry {
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

async function writeIndex(notes: NoteEntry[]): Promise<void> {
  const cat: Catalog = {
    schemaVersion: 1,
    generatedAt: '2026-01-01T00:00:00.000Z',
    backend: 'drive',
    count: notes.length,
    notes,
  };
  await fs.writeFile(path.join(dir, INDEX_FILE), JSON.stringify(cat), 'utf8');
}

describe('placeholder / unreadable files during scan', () => {
  it('skips a 0-byte placeholder .md and lists the readable note (fallback scan)', async () => {
    await fs.writeFile(path.join(dir, 'good.md'), noteText({ id: 'wren-good00000000', title: 'Good' }, 'body'), 'utf8');
    await fs.writeFile(path.join(dir, 'placeholder.md'), '', 'utf8'); // 0-byte cloud placeholder

    const cat = await scanFolderCatalog(dir);
    expect(cat.notes.map((n) => n.title)).toEqual(['Good']);
    // The empty file produced no junk entry (no empty-wrenId row).
    expect(cat.notes.every((n) => n.wrenId.length > 0)).toBe(true);
  });

  it('skips a whitespace-only placeholder too', async () => {
    await fs.writeFile(path.join(dir, 'good.md'), noteText({ id: 'wren-good00000000', title: 'Good' }, 'b'), 'utf8');
    await fs.writeFile(path.join(dir, 'ws.md'), '   \n  \n', 'utf8');
    const cat = await scanFolderCatalog(dir);
    expect(cat.notes).toHaveLength(1);
  });

  it('skips a .md entry that throws on read (e.g. a directory named like a note) and continues', async () => {
    await fs.writeFile(path.join(dir, 'good.md'), noteText({ id: 'wren-good00000000', title: 'Good' }, 'b'), 'utf8');
    // A directory whose name ends in .md: readdir yields it, but isFile() is
    // false so it's skipped before any read — verifies the dirent guard. To
    // simulate a read that *throws*, we instead rely on the try/catch in
    // parseNoteFile (covered by the readNote test below). Here, confirm a
    // non-file .md entry never becomes a note.
    await fs.mkdir(path.join(dir, 'notADir.md'));
    const cat = await scanFolderCatalog(dir);
    expect(cat.notes.map((n) => n.title)).toEqual(['Good']);
  });

  it('does not crash when the whole notes dir is unreadable (returns empty)', async () => {
    const cat = await scanFolderCatalog(path.join(dir, 'nope'));
    expect(cat.count).toBe(0);
    expect(cat.fromFallback).toBe(true);
  });
});

describe('index lag — stale or omitting on-disk notes', () => {
  it('returns fresh on-disk content when the index `updated` is older than the file (staleness re-read)', async () => {
    // Index says this note was last updated in 2020 and has old content.
    await writeIndex([
      indexEntry({ wrenId: 'wren-aaaaaaaaaaaa', path: 'a.md', file: 'a.md', title: 'A', updated: '2020-01-01T00:00:00.000Z' }),
    ]);
    // On disk the file is current ("now" mtime) with fresh content.
    await fs.writeFile(path.join(dir, 'a.md'), noteText({ id: 'wren-aaaaaaaaaaaa', title: 'A' }, 'FRESH on-disk content'), 'utf8');

    const cat = await loadIndex(dir);
    const note = await readNoteByWrenId(dir, cat, 'wren-aaaaaaaaaaaa');
    expect(note.stale).toBe(true);
    expect(note.body).toContain('FRESH on-disk content');
    expect(note.updated > '2020-01-01T00:00:00.000Z').toBe(true);
  });

  it('picks up an on-disk note the (lagging) index omits entirely', async () => {
    // Index knows only about note A...
    await writeIndex([
      indexEntry({ wrenId: 'wren-aaaaaaaaaaaa', path: 'a.md', file: 'a.md', title: 'A', updated: '2026-05-01T00:00:00.000Z' }),
    ]);
    await fs.writeFile(path.join(dir, 'a.md'), noteText({ id: 'wren-aaaaaaaaaaaa', title: 'A' }, 'a body'), 'utf8');
    // ...but note B has synced down to disk before the index caught up.
    await fs.writeFile(path.join(dir, 'b.md'), noteText({ id: 'wren-bbbbbbbbbbbb', title: 'B late' }, 'b body'), 'utf8');

    const cat = await loadIndex(dir);
    expect(cat.fromFallback).toBeUndefined(); // index was present + valid
    const titles = cat.notes.map((n) => n.title).sort();
    expect(titles).toEqual(['A', 'B late']);
    // The reconciled straggler is fully readable by wrenId.
    const b = await readNoteByWrenId(dir, cat, 'wren-bbbbbbbbbbbb');
    expect(b.body).toContain('b body');
  });

  it('reconciliation does not duplicate notes the index already lists', async () => {
    await writeIndex([
      indexEntry({ wrenId: 'wren-aaaaaaaaaaaa', path: 'a.md', file: 'a.md', title: 'A', updated: '2026-05-01T00:00:00.000Z' }),
    ]);
    await fs.writeFile(path.join(dir, 'a.md'), noteText({ id: 'wren-aaaaaaaaaaaa', title: 'A' }, 'a body'), 'utf8');
    const cat = await loadIndex(dir);
    expect(cat.notes.filter((n) => n.wrenId === 'wren-aaaaaaaaaaaa')).toHaveLength(1);
  });

  it('a 0-byte placeholder is NOT reconciled in as a junk straggler', async () => {
    await writeIndex([
      indexEntry({ wrenId: 'wren-aaaaaaaaaaaa', path: 'a.md', file: 'a.md', title: 'A', updated: '2026-05-01T00:00:00.000Z' }),
    ]);
    await fs.writeFile(path.join(dir, 'a.md'), noteText({ id: 'wren-aaaaaaaaaaaa', title: 'A' }, 'a body'), 'utf8');
    await fs.writeFile(path.join(dir, 'ghost.md'), '', 'utf8'); // unhydrated, not in index
    const cat = await loadIndex(dir);
    expect(cat.notes.map((n) => n.title)).toEqual(['A']);
  });
});

describe('readNoteByWrenId on an unreadable file', () => {
  it('throws NoteUnreadableError (clear message) when the file cannot be read', async () => {
    // Index references a path that does not exist on disk (an unhydrated
    // placeholder behaves the same way: the read rejects).
    const cat: Catalog = {
      schemaVersion: 1,
      generatedAt: '2026-01-01T00:00:00.000Z',
      backend: 'drive',
      count: 1,
      notes: [indexEntry({ wrenId: 'wren-ghost0000000', path: 'ghost.md', file: 'ghost.md', title: 'Ghost' })],
    };
    // Note: loadIndex would reconcile disk, but here we hand a catalog directly
    // to readNoteByWrenId to exercise the read-failure path in isolation.
    await expect(readNoteByWrenId(dir, cat, 'wren-ghost0000000')).rejects.toBeInstanceOf(NoteUnreadableError);
    await expect(readNoteByWrenId(dir, cat, 'wren-ghost0000000')).rejects.toThrow(/mirror.*mode|online-only/i);
  });
});
