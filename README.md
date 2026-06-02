# wren-mcp

A local **stdio MCP server** that lets an AI assistant **read** your [Wren](https://wren-ckn.pages.dev) notes — search, list, read a note, and fetch the catalog. It consumes Wren's AI-readable layer (the frozen `.wren-index.json` catalog, the note frontmatter format, and the `_inbox/` staging convention) and never modifies the Wren app.

> **Read-only (v0.1).** This is Build Prompt 1 of 2 — the four read tools. A `wren_create_note` tool (writes into `_inbox/`) and `.mcpb` one-click packaging land in Build Prompt 2.

A *Build with Baker* project.

## Tools

All tools follow **index-then-fetch**: search / list / get_index return **metadata only** (no note bodies); call `wren_read_note` for a body.

| Tool | Input | Output |
|---|---|---|
| `wren_search_notes` | `{ query?, tag?, due_before?, limit? }` | `{ count, notes: [{ wrenId, title, tags, summary, due, updated }] }` |
| `wren_read_note` | `{ wrenId }` | `{ wrenId, title, frontmatter, body, updated, stale }` |
| `wren_list_notes` | `{ tag?, limit?, cursor? }` | `{ items: [...metadata], nextCursor? }` |
| `wren_get_index` | `{}` | the catalog (summarized when large) |

- `query` is a case-insensitive substring over title + summary; `tag` is an exact `namespace:value` match; `due_before` keeps notes with `due` ≤ the given ISO date.
- `limit` defaults to 20, max 50. `cursor` is an opaque pagination token.
- **Staged `_inbox/` notes are excluded** from search/list (they're pending review) but remain readable by `wrenId`.
- `wren_get_index` returns full per-note detail up to **200 notes**; beyond that it drops the heavier `summary`/`tags` fields (keeping ids + dates) so one call can't blow the context budget.

## Configure the notes folder

The server needs to know which folder holds your Wren notes. In priority order:

1. `WREN_NOTES_DIR` environment variable, or
2. `--notes-dir <path>` argument.

If neither is set the server still starts, and every tool returns a clear *"notes folder is not configured"* error. (Build Prompt 2's `.mcpb` manifest will supply `WREN_NOTES_DIR` from a directory picker.)

## Develop

Requires Node 20+.

```bash
npm install
npm run build          # tsc -> dist/
npm test               # vitest
npm run lint

# Run against a real notes folder:
WREN_NOTES_DIR="/path/to/Wren Notes" node dist/index.js

# Or inspect interactively:
WREN_NOTES_DIR="/path/to/Wren Notes" npm run inspect
```

> **stdio discipline:** stdout carries MCP protocol traffic only. All logging goes to **stderr** — never `console.log` in this server (see `src/log.ts`).

## How it reads

`.wren-index.json` at the notes-folder root is the catalog (Wren regenerates it on every save). If it's **absent or unreadable**, the server falls back to scanning top-level `.md` files and building an equivalent in-memory catalog (computing `contentHash` as `sha256-<hex>` of the body) — so it works even before you've saved in Wren. On `wren_read_note`, if a note file's on-disk mtime is newer than the index `updated`, the disk copy wins (and the result is flagged `stale: true`).

See [`docs/internal/architecture.md`](docs/internal/architecture.md) for the module map.
