// Tool-layer tests for the v2 write surface (src/tools.ts): exercises the
// registered handlers end-to-end through a stub MCP server, covering the
// confirm:true gate on delete, the target option on create, conflict rejection
// surfaced as a tool error (not a throw), invalid-tag rejection, and the dry_run
// path. Complements tests/note-editor.test.ts (the underlying logic).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTools, type ToolContext } from '../src/tools.js';

type Handler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

// Minimal McpServer stand-in: capture each registered tool's handler so the
// tests can invoke them directly.
function makeHarness(notesDir: string) {
  const handlers: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => {
      handlers[name] = handler;
    },
  };
  registerTools(server as never, { notesDir } as ToolContext);
  return handlers;
}

let dir: string;
let tools: Record<string, Handler>;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wren-mcp-tools-'));
  tools = makeHarness(dir);
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// Create a note and return its wrenId + the contentHash a write tool needs.
async function createAndRead(target: 'inbox' | 'corpus' = 'corpus') {
  const created = await tools.wren_create_note({ title: 'T', body: 'seed body', target });
  const wrenId = (created.structuredContent as { wrenId: string }).wrenId;
  const read = await tools.wren_read_note({ wrenId });
  const contentHash = (read.structuredContent as { contentHash: string }).contentHash;
  return { wrenId, contentHash };
}

describe('wren_create_note target', () => {
  it('defaults to the inbox', async () => {
    const res = await tools.wren_create_note({ title: 'Capture', body: 'x' });
    const sc = res.structuredContent as { path: string; target: string };
    expect(sc.target).toBe('inbox');
    expect(sc.path.startsWith('_inbox/')).toBe(true);
  });
  it('writes to the corpus when target=corpus', async () => {
    const res = await tools.wren_create_note({ title: 'Direct', body: 'x', target: 'corpus' });
    const sc = res.structuredContent as { path: string; target: string };
    expect(sc.target).toBe('corpus');
    expect(sc.path).not.toContain('_inbox/');
  });
});

describe('wren_read_note', () => {
  it('returns a contentHash for the write gate', async () => {
    const { contentHash } = await createAndRead();
    expect(contentHash).toMatch(/^sha256-[0-9a-f]+$/);
  });
});

describe('wren_update_note (tool layer)', () => {
  it('updates with the correct hash', async () => {
    const { wrenId, contentHash } = await createAndRead();
    const res = await tools.wren_update_note({ wrenId, body: 'updated', expected_content_hash: contentHash });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { written: boolean }).written).toBe(true);
  });

  it('surfaces a stale-hash conflict as a tool error (not a throw)', async () => {
    const { wrenId } = await createAndRead();
    const res = await tools.wren_update_note({ wrenId, body: 'nope', expected_content_hash: 'sha256-stale' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text.toLowerCase()).toContain('conflict');
  });

  it('dry_run returns a diff and writes nothing', async () => {
    const { wrenId, contentHash } = await createAndRead();
    const res = await tools.wren_update_note({ wrenId, body: 'seed body\nmore', expected_content_hash: contentHash, dry_run: true });
    expect((res.structuredContent as { dryRun: boolean }).dryRun).toBe(true);
    // A follow-up read still sees the original hash (nothing written).
    const read = await tools.wren_read_note({ wrenId });
    expect((read.structuredContent as { contentHash: string }).contentHash).toBe(contentHash);
  });
});

describe('wren_set_tags (tool layer)', () => {
  it('rejects a bare (un-namespaced) tag as a tool error', async () => {
    const { wrenId, contentHash } = await createAndRead();
    const res = await tools.wren_set_tags({ wrenId, add: ['bare'], expected_content_hash: contentHash });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Invalid tag');
  });
  it('adds a valid namespaced tag', async () => {
    const { wrenId, contentHash } = await createAndRead();
    const res = await tools.wren_set_tags({ wrenId, add: ['status:todo'], expected_content_hash: contentHash });
    expect((res.structuredContent as { tags: string[] }).tags).toContain('status:todo');
  });
});

describe('wren_delete_note (tool layer)', () => {
  it('refuses without confirm:true', async () => {
    const { wrenId } = await createAndRead();
    const res = await tools.wren_delete_note({ wrenId, confirm: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('confirm:true');
  });
  it('soft-deletes with confirm:true', async () => {
    const { wrenId } = await createAndRead();
    const res = await tools.wren_delete_note({ wrenId, confirm: true });
    expect((res.structuredContent as { softDeleted: boolean }).softDeleted).toBe(true);
  });
});

describe('wren_move_to_corpus (tool layer)', () => {
  it('refuses without confirm:true', async () => {
    const created = await tools.wren_create_note({ title: 'Stage', body: 'b', target: 'inbox' });
    const wrenId = (created.structuredContent as { wrenId: string }).wrenId;
    const res = await tools.wren_move_to_corpus({ wrenId });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('confirm:true');
  });
  it('promotes a staged note with confirm:true', async () => {
    const created = await tools.wren_create_note({ title: 'Stage', body: 'b', target: 'inbox' });
    const wrenId = (created.structuredContent as { wrenId: string }).wrenId;
    const res = await tools.wren_move_to_corpus({ wrenId, confirm: true });
    expect((res.structuredContent as { target: string }).target).toBe('corpus');
  });
  it('errors on a non-inbox note', async () => {
    const { wrenId } = await createAndRead('corpus');
    const res = await tools.wren_move_to_corpus({ wrenId, confirm: true });
    expect(res.isError).toBe(true);
  });
});

describe('confirm-scoping (v2.1: gate delete + move only)', () => {
  it('update/append/set_tags do NOT require confirm — hash + dry_run suffice', async () => {
    const { wrenId, contentHash } = await createAndRead('corpus');
    const upd = await tools.wren_update_note({ wrenId, body: 'b2', expected_content_hash: contentHash });
    expect(upd.isError).toBeFalsy();
    const read = await tools.wren_read_note({ wrenId });
    const h2 = (read.structuredContent as { contentHash: string }).contentHash;
    const app = await tools.wren_append_to_note({ wrenId, text: 'more', expected_content_hash: h2 });
    expect(app.isError).toBeFalsy();
    const read2 = await tools.wren_read_note({ wrenId });
    const h3 = (read2.structuredContent as { contentHash: string }).contentHash;
    const tag = await tools.wren_set_tags({ wrenId, add: ['status:todo'], expected_content_hash: h3 });
    expect(tag.isError).toBeFalsy();
  });
});
