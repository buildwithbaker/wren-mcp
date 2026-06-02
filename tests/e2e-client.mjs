// Throwaway e2e harness: spawn the built server over stdio with a real MCP
// client and exercise every tool. NOT part of the vitest suite — run manually:
//   node tests/e2e-client.mjs <notesDir>
// Verifies the protocol speaks cleanly on stdout (a stray stdout write would
// break the client handshake here).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const notesDir = process.argv[2];
if (!notesDir) {
  console.error('usage: node tests/e2e-client.mjs <notesDir>');
  process.exit(1);
}

function parse(res) {
  return JSON.parse(res.content[0].text);
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  env: { ...process.env, WREN_NOTES_DIR: notesDir },
});
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name).sort();
console.log('TOOLS:', tools.join(', '));

const byQuery = await client.callTool({ name: 'wren_search_notes', arguments: { query: 'grocery' } });
const q = parse(byQuery);
console.log('SEARCH query=grocery ->', q.notes.map((n) => n.wrenId), '| hasBody:', 'body' in (q.notes[0] || {}));

const byTag = await client.callTool({ name: 'wren_search_notes', arguments: { tag: 'status:todo' } });
console.log('SEARCH tag=status:todo ->', parse(byTag).notes.map((n) => n.wrenId));

const byDue = await client.callTool({ name: 'wren_search_notes', arguments: { due_before: '2026-06-15' } });
console.log('SEARCH due_before=2026-06-15 ->', parse(byDue).notes.map((n) => n.wrenId));

const searchAll = await client.callTool({ name: 'wren_search_notes', arguments: {} });
console.log('SEARCH all (inbox excluded?) ->', parse(searchAll).notes.map((n) => n.wrenId));

const read = await client.callTool({ name: 'wren_read_note', arguments: { wrenId: 'wren-aaaaaaaaaaaa' } });
const r = parse(read);
console.log('READ wren-aaaa -> title:', r.title, '| bodyHasMilk:', r.body.includes('milk'), '| stale:', r.stale);

const readStaged = await client.callTool({ name: 'wren_read_note', arguments: { wrenId: 'wren-cccccccccccc' } });
if (readStaged.isError) {
  // Expected in fallback mode: the top-level scan excludes _inbox/, so the
  // staged note isn't catalogued and can't be read by id.
  console.log('READ staged wren-cccc -> isError (expected in fallback):', readStaged.content[0].text.slice(0, 45));
} else {
  console.log('READ staged wren-cccc -> body:', JSON.stringify(parse(readStaged).body.trim()));
}

const readBad = await client.callTool({ name: 'wren_read_note', arguments: { wrenId: 'wren-missing00000' } });
console.log('READ unknown -> isError:', readBad.isError, '| msg:', readBad.content[0].text.slice(0, 40));

const page1 = parse(await client.callTool({ name: 'wren_list_notes', arguments: { limit: 2 } }));
console.log('LIST limit=2 ->', page1.items.map((n) => n.wrenId), '| nextCursor:', !!page1.nextCursor);
const page2 = parse(await client.callTool({ name: 'wren_list_notes', arguments: { limit: 2, cursor: page1.nextCursor } }));
console.log('LIST page2 ->', page2.items.map((n) => n.wrenId), '| nextCursor:', page2.nextCursor ?? '(none)');

const idx = parse(await client.callTool({ name: 'wren_get_index', arguments: {} }));
console.log('GET_INDEX -> count:', idx.count, '| summarized:', !!idx.summarized, '| fromFallback:', !!idx.fromFallback);

await client.close();
console.log('OK');
