// Tests for the write layer (src/note-writer.ts): filename building +
// sanitization + collision, frontmatter shape, id format, _inbox/ pathing, and
// safety (no overwrite, never escapes _inbox/). Runs against real temp folders.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateNoteId,
  buildNoteFilename,
  uniqueNoteName,
  serializeStagedNote,
  createInboxNote,
} from '../src/note-writer.js';
import { loadIndex, readNoteByWrenId, parseFrontmatter } from '../src/notes-source.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wren-mcp-write-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('generateNoteId', () => {
  it('is "wren-" + 12 lowercase base36 chars', () => {
    expect(generateNoteId()).toMatch(/^wren-[0-9a-z]{12}$/);
  });
  it('is practically unique', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateNoteId()));
    expect(ids.size).toBe(1000);
  });
});

describe('buildNoteFilename', () => {
  it('formats "YYYY-MM-DD - <title>.md" from the created date', () => {
    expect(buildNoteFilename('2026-06-01T10:00:00.000Z', 'My Note')).toBe('2026-06-01 - My Note.md');
  });
  it('strips filesystem-illegal characters', () => {
    expect(buildNoteFilename('2026-06-01', 'a/b:c*?"<>|d')).toBe('2026-06-01 - a b c d.md');
  });
  it('collapses whitespace and trims', () => {
    expect(buildNoteFilename('2026-06-01', '  hello   world  ')).toBe('2026-06-01 - hello world.md');
  });
  it('defaults an empty/symbol-only title to Untitled', () => {
    expect(buildNoteFilename('2026-06-01', '   ')).toBe('2026-06-01 - Untitled.md');
  });
  it('caps the title around 80 chars', () => {
    const long = 'x'.repeat(200);
    const name = buildNoteFilename('2026-06-01', long);
    const title = name.replace('2026-06-01 - ', '').replace('.md', '');
    expect(title.length).toBeLessThanOrEqual(80);
  });
});

describe('uniqueNoteName', () => {
  it('returns the name unchanged when free', async () => {
    expect(await uniqueNoteName('a.md', () => false)).toBe('a.md');
  });
  it('appends (2), (3)… on collision', async () => {
    const taken = new Set(['a.md', 'a (2).md']);
    expect(await uniqueNoteName('a.md', (n) => taken.has(n))).toBe('a (3).md');
  });
});

describe('serializeStagedNote', () => {
  const base = {
    wrenId: 'wren-aaaaaaaaaaaa',
    title: 'Hello: World',
    createdIso: '2026-06-01T10:00:00.000Z',
    modifiedIso: '2026-06-01T10:00:00.000Z',
    body: 'body text',
  };

  it('emits fields in Wren order: id, title, created, modified, color, [due], [tags]', () => {
    const text = serializeStagedNote({ ...base, due: '2026-06-10', tags: ['status:todo'] });
    const keys = text
      .split('\n')
      .filter((l) => /^[a-z]+:/.test(l))
      .map((l) => l.slice(0, l.indexOf(':')));
    expect(keys).toEqual(['id', 'title', 'created', 'modified', 'color', 'due', 'tags']);
  });
  it('JSON-quotes the title (so colons survive) and omits unset optionals', () => {
    const text = serializeStagedNote(base);
    expect(text).toContain('title: "Hello: World"');
    expect(text).not.toMatch(/\ndue:/);
    expect(text).not.toMatch(/\ntags:/);
    expect(text).not.toMatch(/\nsummary:/); // never written in v1
  });
  it('writes tags as an inline JSON array when provided', () => {
    const text = serializeStagedNote({ ...base, tags: ['status:todo', 'project:wren'] });
    expect(text).toContain('tags: ["status:todo","project:wren"]');
  });
  it('round-trips through the reader', () => {
    const text = serializeStagedNote({ ...base, due: '2026-06-10', tags: ['a:b'] });
    const { frontmatter, body } = parseFrontmatter(text);
    expect(frontmatter.id).toBe('wren-aaaaaaaaaaaa');
    expect(frontmatter.title).toBe('Hello: World');
    expect(frontmatter.due).toBe('2026-06-10');
    expect(frontmatter.tags).toEqual(['a:b']);
    expect(body.trim()).toBe('body text');
  });
});

describe('createInboxNote', () => {
  it('writes into _inbox/, returns wrenId + _inbox/ path, with valid frontmatter', async () => {
    const res = await createInboxNote(dir, { title: 'Captured', body: 'hello' }, '2026-06-01T10:00:00.000Z');
    expect(res.wrenId).toMatch(/^wren-[0-9a-z]{12}$/);
    expect(res.path).toBe('_inbox/2026-06-01 - Captured.md');

    const onDisk = await fs.readFile(path.join(dir, res.path), 'utf8');
    expect(onDisk.startsWith('---\nid: ' + res.wrenId + '\n')).toBe(true);
    const { frontmatter, body } = parseFrontmatter(onDisk);
    expect(frontmatter.id).toBe(res.wrenId);
    expect(frontmatter.title).toBe('Captured');
    expect(frontmatter.color).toBe('default');
    expect(body.trim()).toBe('hello');
  });

  it('creates the _inbox/ folder if absent', async () => {
    await expect(fs.access(path.join(dir, '_inbox'))).rejects.toThrow();
    await createInboxNote(dir, { title: 'X', body: 'y' });
    await expect(fs.access(path.join(dir, '_inbox'))).resolves.toBeUndefined();
  });

  it('never overwrites an existing inbox file (collision -> (2))', async () => {
    const a = await createInboxNote(dir, { title: 'Dup', body: 'first' }, '2026-06-01T10:00:00.000Z');
    const b = await createInboxNote(dir, { title: 'Dup', body: 'second' }, '2026-06-01T10:00:00.000Z');
    expect(a.path).toBe('_inbox/2026-06-01 - Dup.md');
    expect(b.path).toBe('_inbox/2026-06-01 - Dup (2).md');
    // First file is intact (not clobbered).
    expect((await fs.readFile(path.join(dir, a.path), 'utf8'))).toContain('first');
    expect((await fs.readFile(path.join(dir, b.path), 'utf8'))).toContain('second');
  });

  it('writes ONLY inside _inbox/ — the notes root gains no new .md', async () => {
    await createInboxNote(dir, { title: 'Staged', body: 'b' });
    const rootEntries = await fs.readdir(dir, { withFileTypes: true });
    const rootMd = rootEntries.filter((e) => e.isFile() && e.name.endsWith('.md'));
    expect(rootMd).toHaveLength(0);
  });

  it('a created note is read back by wrenId and shows inbox:true in the catalog (live inbox scan)', async () => {
    // Seed one main-corpus note so the catalog has company.
    await fs.writeFile(
      path.join(dir, 'existing.md'),
      serializeStagedNote({
        wrenId: 'wren-existing0000',
        title: 'Existing',
        createdIso: '2026-05-01T00:00:00.000Z',
        modifiedIso: '2026-05-01T00:00:00.000Z',
        body: 'old',
      }),
      'utf8'
    );
    const res = await createInboxNote(dir, { title: 'New staged', body: 'fresh' });

    // loadIndex merges a live _inbox/ scan, so the just-created note is present
    // and readable immediately — no .wren-index.json needed.
    const catalog = await loadIndex(dir);
    expect(catalog.fromFallback).toBe(true);
    const staged = catalog.notes.find((n) => n.wrenId === res.wrenId);
    expect(staged).toBeTruthy();
    expect(staged?.inbox).toBe(true);
    expect(staged?.path).toBe(res.path);
    expect(catalog.notes.some((n) => n.title === 'Existing')).toBe(true);

    const note = await readNoteByWrenId(dir, catalog, res.wrenId);
    expect(note.body.trim()).toBe('fresh');
  });
});
