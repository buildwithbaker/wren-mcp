// log.ts
//
// CRITICAL stdio-MCP rule: stdout is the protocol channel. Every diagnostic
// MUST go to stderr — a stray stdout write corrupts the JSON-RPC stream and
// breaks the client. Use these helpers (or process.stderr) everywhere; never
// console.log in this server.

export function log(...args: unknown[]): void {
  console.error('[wren-mcp]', ...args);
}

export function logError(...args: unknown[]): void {
  console.error('[wren-mcp][error]', ...args);
}
