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
  manifest.json           .mcpb Desktop Extension manifest (user_config -> env)
  icon.png                512px Wren logo for the extension
  .mcpbignore             excludes src/tests/dev cruft from the bundle

  src/
    index.ts              entry point. Resolves config, creates McpServer,
                          registers tools, connects StdioServerTransport.
    config.ts             resolveConfig(): WREN_NOTES_DIR | --notes-dir | null.
                          NOTES_DIR_NOT_CONFIGURED message.
    log.ts                stderr-only logging (log / logError). NEVER stdout.
    notes-source.ts       ★ the read layer (pure-ish, unit-tested):
                            loadIndex (+ live _inbox/ merge) / scanFolderCatalog
                            (fallback) / scanInboxNotes, searchNotes / listNotes
                            / readNoteByWrenId / getIndexSummary, parseFrontmatter,
                            NoteNotFoundError.
    note-writer.ts        ★ the write layer (unit-tested): generateNoteId /
                            buildNoteFilename / uniqueNoteName / serializeStagedNote
                            / createInboxNote. Mirrors Wren's note conventions so
                            the PWA reads created notes back. Writes ONLY _inbox/.
    tools.ts              registerTools(server, ctx): the 5 tools as thin wrappers
                          over notes-source (reads) + note-writer (create).

  tests/
    notes-source.test.ts  read-layer vitest suite over real temp folders.
    note-writer.test.ts   write-layer vitest suite (filename/frontmatter/safety).
    e2e-client.mjs        manual end-to-end harness (spawns the server with a
                          real MCP client over stdio). Not in the vitest run.

  docs/internal/architecture.md   this file
  docs/INSTALL.md         non-dev install steps for the .mcpb
```

---

## 3. Data flow

```
   MCP client (Claude)
        |  JSON-RPC over stdio
   index.ts  --registerTools-->  tools.ts
                                  |        \
              (reads) notes-source.ts    note-writer.ts (create)
                                  |        |  fs writes -> _inbox/ only
                          <notesDir>/.wren-index.json   (catalog; or fallback scan)
                          <notesDir>/*.md               (bodies, on read only)
                          <notesDir>/_inbox/*.md        (staged: live-scanned + created)
```

- **Index-then-fetch:** `wren_search_notes` / `wren_list_notes` / `wren_get_index` return metadata only. Bodies are read from disk solely by `wren_read_note`.
- **Catalog source:** `loadIndex()` prefers `.wren-index.json`; on absence / parse failure / wrong shape it falls back to `scanFolderCatalog()` (top-level `.md` scan, reserved names excluded, `contentHash` = sha256 of body).
- **Live inbox merge:** disk is the source of truth for staged notes. `loadIndex()` (and the fallback scan) always replace any index inbox entries with a live `scanInboxNotes()` of `_inbox/`, so a note just written by `wren_create_note` is immediately readable and visible in `wren_get_index` (`inbox: true`) — no wait for Wren to regenerate its index. The main corpus still comes from the index (no full rescan).
- **Staleness:** `readNoteByWrenId()` stats the file; if mtime > index `updated`, the disk copy is returned and flagged `stale: true` (the file is the source of truth).
- **Inbox:** staged notes (`inbox: true`) are excluded from search/list (via `corpus()`) but readable by `wrenId` and present in `wren_get_index`.
- **Create:** `note-writer.createInboxNote()` writes ONLY into `<notesDir>/_inbox/` — mints a fresh `wren-…` id, builds Wren's `YYYY-MM-DD - <Title>.md` name (collision-suffixed), serializes Wren-exact frontmatter (field order `id, title, created, modified, color, [due], [tags]`), and writes with the exclusive `wx` flag so it never overwrites. The Wren PWA then shows it in its Inbox for promote/discard.

---

## 4. Conventions

- **ES modules, TypeScript strict, Node 20+.** Relative imports use the `.js` extension (NodeNext).
- **stderr-only logging** via `src/log.ts`. A stray `console.log` corrupts the stdio protocol stream — don't.
- **Tools are thin.** All logic lives in `notes-source.ts` (reads) and `note-writer.ts` (create) and is unit-tested without MCP; `tools.ts` only validates inputs (zod), calls the source/writer layer, and formats MCP results (text + `structuredContent`).
- **Errors, not crashes.** Every handler catches and returns a clean tool error (`isError: true`): not-configured, unknown `wrenId` (`NoteNotFoundError`), unreadable file, write failure.

---

## 5. Packaging (.mcpb Desktop Extension)

- **`manifest.json`** (manifest_version 0.2): `display_name` "Wren", privacy-forward description, `server.entry_point` = `dist/index.js`, and a `user_config.notes_dir` **directory** field wired to the server via `server.mcp_config.env.WREN_NOTES_DIR = "${user_config.notes_dir}"` — i.e. the directory the user picks in Claude Desktop becomes the env var `config.ts` already reads. Icon = `icon.png` (512px Wren logo). Unsigned (side-load only; Connectors Directory submission deferred).
- **`npm run pack`** → `tsc` build, `npm prune --omit=dev` (so only runtime deps ship), `mcpb pack . Wren.mcpb`, then `npm install` to restore dev deps. `.mcpbignore` drops `src/`, tests, configs, docs. Result ~2.5 MB (`dist/` + `@modelcontextprotocol/sdk` + `zod`).
- Install steps for non-devs: [`../INSTALL.md`](../INSTALL.md).

---

## 6. Future work

- **Connectors Directory submission** (deferred per the SOW — side-load only for v1; would require signing + a privacy policy).
- Signing the `.mcpb` (`mcpb sign`) for distribution outside side-loading.
