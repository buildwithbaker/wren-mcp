# wren-mcp — Architecture Reference

Module map and conventions for the Wren MCP server. Pairs with the root [`README.md`](../../README.md) (what it is + dev run) and the Wren repo's `docs/README-for-AI.md` (the index/note contract this server consumes). Last updated 2026-06-01.

---

## 1. What it is

A local **stdio** MCP server exposing read access to a Wren notes folder. It is a **consumer** of Wren's AI-readable layer (Phases 1–4): the stable `wren-…` frontmatter ids, the frozen `.wren-index.json` catalog (schemaVersion 1), and the `_inbox/` staging subfolder. It does not modify the Wren PWA repo or the notes (read-only in v0.1).

Transport is **stdio**: the client launches `node dist/index.js` as a subprocess and speaks JSON-RPC over stdin/stdout. **stdout is the protocol channel** — all diagnostics go to stderr.

---

## 2. Module map

```
wren-mcp/
  package.json            name "wren-mcp", type module, bin -> dist/index.js
  tsconfig.json           NodeNext ESM, strict, outDir dist/
  eslint.config.js        flat config (typescript-eslint), mirrors the Wren repo
  vitest.config.ts        node env, tests/**/*.test.ts
  .env.example            documents WREN_NOTES_DIR

  src/
    index.ts              entry point. Resolves config, creates McpServer,
                          registers tools, connects StdioServerTransport.
    config.ts             resolveConfig(): WREN_NOTES_DIR | --notes-dir | null.
                          NOTES_DIR_NOT_CONFIGURED message.
    log.ts                stderr-only logging (log / logError). NEVER stdout.
    notes-source.ts       ★ the read layer (pure-ish, unit-tested):
                            loadIndex / scanFolderCatalog (fallback),
                            searchNotes / listNotes / readNoteByWrenId /
                            getIndexSummary, parseFrontmatter, NoteNotFoundError.
    tools.ts              registerTools(server, ctx): the 4 read tools as thin
                          wrappers over notes-source. Single extension point.

  tests/
    notes-source.test.ts  vitest suite over real temp folders.
    e2e-client.mjs        manual end-to-end harness (spawns the server with a
                          real MCP client over stdio). Not in the vitest run.

  docs/internal/architecture.md   this file
```

---

## 3. Data flow

```
   MCP client (Claude)
        |  JSON-RPC over stdio
   index.ts  --registerTools-->  tools.ts
                                    |  (thin wrappers, index-then-fetch)
                                 notes-source.ts
                                    |  fs reads
                          <notesDir>/.wren-index.json   (catalog; or fallback scan)
                          <notesDir>/*.md               (bodies, on read only)
```

- **Index-then-fetch:** `wren_search_notes` / `wren_list_notes` / `wren_get_index` return metadata only. Bodies are read from disk solely by `wren_read_note`.
- **Catalog source:** `loadIndex()` prefers `.wren-index.json`; on absence / parse failure / wrong shape it falls back to `scanFolderCatalog()` (top-level `.md` scan, reserved names + `_inbox/` excluded, `contentHash` = sha256 of body).
- **Staleness:** `readNoteByWrenId()` stats the file; if mtime > index `updated`, the disk copy is returned and flagged `stale: true` (the file is the source of truth).
- **Inbox:** staged notes (`inbox: true`) are excluded from search/list but readable by `wrenId` (so a model can read a note it just created — relevant once Prompt 2's create tool exists).

---

## 4. Conventions

- **ES modules, TypeScript strict, Node 20+.** Relative imports use the `.js` extension (NodeNext).
- **stderr-only logging** via `src/log.ts`. A stray `console.log` corrupts the stdio protocol stream — don't.
- **Tools are thin.** All logic lives in `notes-source.ts` and is unit-tested without MCP; `tools.ts` only validates inputs (zod), calls the source layer, and formats MCP results (text + `structuredContent`).
- **Errors, not crashes.** Every handler catches and returns a clean tool error (`isError: true`): not-configured, unknown `wrenId` (`NoteNotFoundError`), unreadable file.

---

## 5. Extension points (Build Prompt 2)

- **`wren_create_note`** → write a new note into `_inbox/`. Register it in `registerTools()` (the marked spot). The notes-dir/config plumbing, the inbox path convention, and the read-back-by-wrenId path (inbox notes are readable) are already in place.
- **`.mcpb` packaging** → a manifest with a directory config that sets `WREN_NOTES_DIR`, for one-click install. No code change needed beyond the manifest; `config.ts` already reads the env var.
