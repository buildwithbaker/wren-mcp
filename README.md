# wren-mcp

A local **stdio MCP server** that lets an AI assistant **read** your [Wren](https://wren-ckn.pages.dev) notes — search, list, read a note, browse the catalog — and **create** new notes (staged in Wren's inbox for your review). It consumes Wren's AI-readable layer (the frozen `.wren-index.json` catalog, the note frontmatter format, and the `_inbox/` staging convention) and never modifies the Wren app.

> **One-click install:** package it as a Claude Desktop extension with `npm run pack` (produces `Wren.mcpb`) — see [`docs/INSTALL.md`](docs/INSTALL.md).

A *Build with Baker* project.

## Tools

Reads follow **index-then-fetch**: search / list / get_index return **metadata only** (no note bodies); call `wren_read_note` for a body. The one write, `wren_create_note`, stages into `_inbox/` only — it never touches the main corpus.

| Tool | Input | Output |
|---|---|---|
| `wren_search_notes` | `{ query?, tag?, due_before?, limit? }` | `{ count, notes: [{ wrenId, title, tags, summary, due, updated }] }` |
| `wren_read_note` | `{ wrenId }` | `{ wrenId, title, frontmatter, body, updated, stale }` |
| `wren_list_notes` | `{ tag?, limit?, cursor? }` | `{ items: [...metadata], nextCursor? }` |
| `wren_get_index` | `{}` | the catalog (summarized when large) |
| `wren_create_note` | `{ title, body, tags?, due? }` | `{ wrenId, path }` (path is `_inbox/<file>`) |

- `query` is a case-insensitive substring over title + summary; `tag` is an exact `namespace:value` match; `due_before` keeps notes with `due` ≤ the given ISO date.
- `limit` defaults to 20, max 50. `cursor` is an opaque pagination token.
- **Staged `_inbox/` notes are excluded** from search/list (they're pending review) but remain readable by `wrenId` and appear in `wren_get_index` with `inbox: true`.
- `wren_get_index` returns full per-note detail up to **200 notes**; beyond that it drops the heavier `summary`/`tags` fields (keeping ids + dates) so one call can't blow the context budget.
- **`wren_create_note` safety:** writes go only into `<notesDir>/_inbox/`, with a freshly minted `wren-…` id, Wren's `YYYY-MM-DD - <Title>.md` filename (collision-suffixed), and Wren-exact frontmatter. It never overwrites an existing file and never writes to the main corpus.

## Configure the notes folder

The server needs to know which folder holds your Wren notes. In priority order:

1. `WREN_NOTES_DIR` environment variable, or
2. `--notes-dir <path>` argument.

If neither is set the server still starts, and every tool returns a clear *"notes folder is not configured"* error. When installed as a Desktop Extension, the `.mcpb` manifest's **"Wren notes folder"** directory picker supplies `WREN_NOTES_DIR` automatically (see [`docs/INSTALL.md`](docs/INSTALL.md)).

**Using Wren on the Google Drive backend?** If your notes live in Google Drive, point the server at your Drive-synced "Wren Notes" folder (Google Drive for Desktop, mirror mode) — see [`docs/DRIVE.md`](docs/DRIVE.md). Still fully local: the server reads the already-synced local copy.

## Package as a Claude Desktop extension

```bash
npm run pack       # build -> prune to prod deps -> mcpb pack -> restore dev deps
```

Produces **`Wren.mcpb`** (~2.5 MB; bundles `dist/` + runtime deps only). Install it by dragging it into Claude Desktop → Settings → Extensions, then set your notes folder. The bundle is unsigned (side-load only; Connectors Directory submission is deferred). Full steps: [`docs/INSTALL.md`](docs/INSTALL.md).

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
