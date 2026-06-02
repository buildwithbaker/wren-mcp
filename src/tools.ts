// tools.ts
//
// The MCP tool surface — thin wrappers over src/notes-source.ts (reads) and
// src/note-writer.ts (the one write). Index-then-fetch is the rule: search /
// list / get_index return METADATA ONLY; the model calls wren_read_note for
// bodies. The only write is wren_create_note, which stages into _inbox/ — it
// never touches the main corpus.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NOTES_DIR_NOT_CONFIGURED } from './config.js';
import {
  loadIndex,
  searchNotes,
  listNotes,
  readNoteByWrenId,
  getIndexSummary,
  NoteNotFoundError,
  MAX_LIMIT,
} from './notes-source.js';
import { createInboxNote } from './note-writer.js';
import { logError } from './log.js';

/** Shared context handed to every tool handler. */
export interface ToolContext {
  /** Absolute path to the Wren notes folder, or null if not configured. */
  notesDir: string | null;
}

// MCP tool results are content arrays. We return human-readable JSON text plus a
// machine-readable structuredContent payload (clients that support it can use
// the latter; everyone else reads the text).
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  const structured =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { result: payload };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: structured,
  };
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve the catalog or throw a configured-or-not guard error. */
async function requireCatalog(ctx: ToolContext) {
  if (!ctx.notesDir) {
    const e = new Error(NOTES_DIR_NOT_CONFIGURED);
    e.name = 'NotesDirNotConfigured';
    throw e;
  }
  return loadIndex(ctx.notesDir);
}

function toFailure(toolName: string, err: unknown): ToolResult {
  if (err instanceof NoteNotFoundError) return fail(err.message);
  if (err instanceof Error && err.name === 'NotesDirNotConfigured') return fail(err.message);
  // Unreadable file / unexpected — log detail to stderr, return a clean message.
  logError(`${toolName} failed:`, err);
  const msg = err instanceof Error ? err.message : String(err);
  return fail(`${toolName} failed: ${msg}`);
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  // ---- wren_search_notes -------------------------------------------------
  server.registerTool(
    'wren_search_notes',
    {
      title: 'Search Wren notes',
      description:
        'Search the notes catalog by title/summary text, tag, and/or due date. ' +
        'Returns metadata only (no note bodies) — call wren_read_note for a body. ' +
        'Staged _inbox/ notes are excluded. Use this to find notes before reading them.',
      inputSchema: {
        query: z.string().optional().describe('Case-insensitive substring matched against title + summary.'),
        tag: z.string().optional().describe('Exact tag match, e.g. "status:todo" or "project:wren".'),
        due_before: z
          .string()
          .optional()
          .describe('ISO date/timestamp; keep notes whose `due` is on or before this.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Max results (default 20, max ${MAX_LIMIT}).`),
      },
    },
    async (args) => {
      try {
        const catalog = await requireCatalog(ctx);
        const hits = searchNotes(catalog, {
          query: args.query,
          tag: args.tag,
          dueBefore: args.due_before,
          limit: args.limit,
        });
        return ok({ count: hits.length, notes: hits });
      } catch (err) {
        return toFailure('wren_search_notes', err);
      }
    }
  );

  // ---- wren_read_note ----------------------------------------------------
  server.registerTool(
    'wren_read_note',
    {
      title: 'Read a Wren note',
      description:
        'Read one note in full (frontmatter + Markdown body) by its stable wrenId ' +
        '(e.g. "wren-k3p9x2m7q1za"). Works for any note including staged _inbox/ notes. ' +
        'If the file on disk is newer than the index, the fresh disk copy is returned.',
      inputSchema: {
        wrenId: z.string().min(1).describe('Stable note id, e.g. "wren-k3p9x2m7q1za".'),
      },
    },
    async (args) => {
      try {
        if (!ctx.notesDir) return fail(NOTES_DIR_NOT_CONFIGURED);
        const catalog = await loadIndex(ctx.notesDir);
        const note = await readNoteByWrenId(ctx.notesDir, catalog, args.wrenId);
        return ok(note);
      } catch (err) {
        return toFailure('wren_read_note', err);
      }
    }
  );

  // ---- wren_list_notes ---------------------------------------------------
  server.registerTool(
    'wren_list_notes',
    {
      title: 'List Wren notes',
      description:
        'List note metadata (newest first), paginated. Returns metadata only (no bodies). ' +
        'Pass the returned nextCursor to fetch the next page. Staged _inbox/ notes are excluded.',
      inputSchema: {
        tag: z.string().optional().describe('Optional exact tag filter.'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Page size (default 20, max ${MAX_LIMIT}).`),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous call.'),
      },
    },
    async (args) => {
      try {
        const catalog = await requireCatalog(ctx);
        const result = listNotes(catalog, {
          tag: args.tag,
          limit: args.limit,
          cursor: args.cursor,
        });
        return ok(result);
      } catch (err) {
        return toFailure('wren_list_notes', err);
      }
    }
  );

  // ---- wren_get_index ----------------------------------------------------
  server.registerTool(
    'wren_get_index',
    {
      title: 'Get the Wren note index',
      description:
        'Return the whole notes catalog (metadata for every note). For large corpora the ' +
        'per-note detail is summarized to protect the context budget. Use wren_search_notes ' +
        'for targeted lookups; use this for a full overview.',
      inputSchema: {},
    },
    async () => {
      try {
        const catalog = await requireCatalog(ctx);
        return ok(getIndexSummary(catalog));
      } catch (err) {
        return toFailure('wren_get_index', err);
      }
    }
  );

  // ---- wren_create_note (writes to _inbox/ staging only) -----------------
  server.registerTool(
    'wren_create_note',
    {
      title: 'Create a Wren note (staged for review)',
      description:
        'Capture a new note. It is written to the _inbox/ staging folder, NOT the main ' +
        'notes — the user reviews and promotes it in the Wren app. Writes never touch, ' +
        'overwrite, or delete existing notes. Returns the new wrenId and _inbox/ path.',
      inputSchema: {
        title: z.string().min(1).describe('Note title (also used to derive the filename).'),
        body: z.string().describe('Markdown body of the note.'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional namespaced tags, e.g. ["status:todo", "project:wren"].'),
        due: z.string().optional().describe('Optional ISO date/timestamp due value.'),
      },
    },
    async (args) => {
      try {
        if (!ctx.notesDir) return fail(NOTES_DIR_NOT_CONFIGURED);
        const result = await createInboxNote(ctx.notesDir, {
          title: args.title,
          body: args.body,
          tags: args.tags,
          due: args.due,
        });
        return ok(result);
      } catch (err) {
        return toFailure('wren_create_note', err);
      }
    }
  );
}
