# wren-mcp

A local **stdio MCP server** that lets an AI assistant **read and write** your [Wren](https://wren-ckn.pages.dev) notes — search, list, read, browse the catalog, **create, update, append, tag, soft-delete, and promote** notes. It consumes Wren's AI-readable layer (the frozen `.wren-index.json` catalog, the note frontmatter format, and the `_inbox/` staging convention) and never modifies the Wren app's code. Writes go to the note `.md` files only; Wren re-generates its index on its next save/launch (see [Index reconciliation](#index-reconciliation-model-a)).

> **One-click install:** package it as a Claude Desktop extension with `npm run pack` (produces `Wren.mcpb`) — see [`docs/INSTALL.md`](docs/INSTALL.md).

A *Build with Baker* project.

## Tools

Reads follow **index-then-fetch**: search / list / get_index return **metadata only** (no note bodies); call `wren_read_note` for a body.

### Reads

| Tool | Input | Output |
|---|---|---|
| `wren_search_notes` | `{ query?, tag?, due_before?, limit? }` | `{ count, notes: [{ wrenId, title, tags, summary, due, updated }] }` |
| `wren_read_note` | `{ wrenId }` | `{ wrenId, title, frontmatter, body, updated, contentHash, stale }` |
| `wren_list_notes` | `{ tag?, limit?, cursor? }` | `{ items: [...metadata], nextCursor? }` |
| `wren_get_index` | `{}` | the catalog (summarized when large) |

### Writes

| Tool | Input | Output |
|---|---|---|
| `wren_create_note` | `{ title, body, tags?, due?, target? }` | `{ wrenId, path, target }` (`target` = `inbox` \| `corpus`, default `inbox`) |
| `wren_update_note` | `{ wrenId, body?, title?, due?, expected_content_hash, dry_run? }` | `{ wrenId, path, updated, contentHash, written }` or a dry-run diff |
| `wren_append_to_note` | `{ wrenId, text, expected_content_hash, dry_run? }` | same as update |
| `wren_set_tags` | `{ wrenId, add?, remove?, expected_content_hash, dry_run? }` | `{ ..., tags }` or a dry-run diff |
| `wren_delete_note` | `{ wrenId, confirm: true }` | `{ wrenId, softDeleted, originalPath, trashedPath }` |
| `wren_move_to_corpus` | `{ wrenId }` | `{ wrenId, fromPath, path, target: "corpus" }` |

- `query` is a case-insensitive substring over title + summary; `tag` is an exact `namespace:value` match; `due_before` keeps notes with `due` ≤ the given ISO date.
- `limit` defaults to 20, max 50. `cursor` is an opaque pagination token.
- **Staged `_inbox/` notes are excluded** from search/list (they're pending review) but remain readable by `wrenId` and appear in `wren_get_index` with `inbox: true`.
- `wren_get_index` returns full per-note detail up to **200 notes**; beyond that it drops the heavier `summary`/`tags` fields (keeping ids + dates) so one call can't blow the context budget.

### Write-safety model

Every modifying tool follows these guardrails (KB modules 03/04):

- **Read-first + optimistic concurrency.** `wren_read_note` returns a `contentHash` (`sha256-<hex>` of the body — Wren's FS convention). `update`/`append`/`set_tags` require you to pass it back as `expected_content_hash`. The server re-reads the file and recomputes the hash **live**; if it differs (the note changed underneath you), the write is **rejected as a conflict** — never a blind overwrite. (The gate hashes the body; a tag-only concurrent edit is last-write-wins, matching Wren.)
- **`dry_run`.** Pass `dry_run: true` to `update`/`append`/`set_tags` to get a diff (changed frontmatter fields + a body line-diff + before/after hashes) **without writing**.
- **Soft-delete only.** `wren_delete_note` requires `confirm: true` and **moves** the file to a `.trash/` folder — it never hard-deletes. The note disappears from Wren on its next index refresh; recovering it currently means moving the file back out of `.trash/` (Wren has no trash UI — see the flag below).
- **Namespaced tags.** `wren_set_tags` validates every added tag as `namespace:value` (e.g. `status:todo`); a bare tag is **rejected, never auto-prefixed**.
- **Untrusted content.** Note bodies are treated as data, never instructions. There is no exfiltration tool, and the server never acts on text embedded in a note body.
- **Path-traversal safe.** Every write resolves inside the configured notes dir; `..`/absolute escapes are rejected.
- **Create safety:** a freshly minted `wren-…` id, Wren's `YYYY-MM-DD - <Title>.md` filename (collision-suffixed), Wren-exact frontmatter, and an exclusive write — an existing file is never overwritten. `target: "inbox"` (default) stages into `_inbox/`; `target: "corpus"` writes straight to the live notes.

### Index reconciliation (model A)

`.wren-index.json` is a **frozen cross-repo contract owned by the Wren PWA**, not this server. The write tools use **model A: Wren re-indexes.** The MCP writes/moves the note `.md` files only and **never edits `.wren-index.json`**; the Wren app regenerates it on its next save/launch (its scan is top-level + `_inbox/`, so it picks up changed/added notes, drops a soft-deleted one, and never descends into `.trash/`). In the gap, the MCP's own reads stay correct via its fallback folder scan + per-note mtime-staleness re-read, so `expected_content_hash` is always computed against live disk content. Changing the index schema would require a coordinated `schemaVersion` bump on the Wren side — out of scope here.

> ⚠ **Flag for review:** `.trash/` is an **MCP-only** soft-delete convention — Wren itself hard-deletes and has no trash concept. A soft-deleted note is safe on disk but invisible to Wren; restoring it is a manual file move today. A future `wren_restore` tool (or Wren-side trash support) would close this loop.

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
