#!/usr/bin/env node
// index.ts
//
// Entry point: a local stdio MCP server exposing read access to a Wren notes
// folder. stdout carries MCP protocol traffic ONLY — all logging is on stderr
// (see log.ts). Notes dir is resolved once at startup from WREN_NOTES_DIR or
// --notes-dir; if unset, the server still starts and tools report a clear error.

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveConfig } from './config.js';
import { registerTools } from './tools.js';
import { log, logError } from './log.js';

// Single source of truth for the version: package.json. `../package.json`
// resolves to the bundle root both in dev (dist/index.js) and inside the packed
// .mcpb (dist/ + package.json siblings), so the server can never again report a
// version that drifts from the package/manifest (the stale-0.2.0 bug).
const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require('../package.json') as { version: string };

async function main(): Promise<void> {
  const { notesDir } = resolveConfig();
  if (notesDir) {
    log(`Notes folder: ${notesDir}`);
  } else {
    log('No notes folder configured (set WREN_NOTES_DIR or --notes-dir). Tools will report this.');
  }

  const server = new McpServer({
    name: 'wren-mcp',
    version: SERVER_VERSION,
  });

  registerTools(server, { notesDir });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log('wren-mcp ready on stdio.');
}

main().catch((err) => {
  logError('Fatal startup error:', err);
  process.exit(1);
});
