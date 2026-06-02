// notes-source.ts
//
// The read layer for a Wren notes folder. Pure-ish and unit-testable: every
// function takes the notes dir (or an already-loaded catalog) as a parameter —
// no global state, no MCP coupling. src/tools.ts wraps these.
//
// Contract consumed (see the wren repo's docs/README-for-AI.md):
//   - `<notesDir>/.wren-index.json` is the catalog (FROZEN schemaVersion 1).
//   - Notes are `.md` files: YAML frontmatter + Markdown body.
//   - Reserved/managed files are NOT notes; `_inbox/` holds staged notes.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { log } from './log.js';

export const INDEX_FILE = '.wren-index.json';
export const INBOX_DIR = '_inbox';
export const SUPPORTED_SCHEMA_VERSION = 1;

// Files in the notes root that are Wren-managed, not user notes.
export const RESERVED_NOTE_NAMES = new Set([
  '_index.md',
  'tasks.md',
  '.wren-index.json',
  'README-for-AI.md',
]);

// When the catalog is larger than this, getIndexSummary() drops the heavier
// per-note fields (summary/tags) so a single wren_get_index call stays within a
// reasonable context budget. Documented in tools.ts / the README.
export const INDEX_SUMMARY_THRESHOLD = 200;

/** One catalog entry — the FROZEN .wren-index.json notes[] shape. */
export interface NoteEntry {
  wrenId: string;
  storageId: string;
  path: string;
  file: string;
  title: string;
  summary: string;
  due: string;
  tags: string[];
  color: string;
  created: string;
  updated: string;
  contentHash: string;
  inbox?: boolean;
}

export interface Catalog {
  schemaVersion: number;
  generatedAt: string;
  backend: string;
  count: number;
  notes: NoteEntry[];
  /** True when this catalog was rebuilt by the fallback scan (no index file). */
  fromFallback?: boolean;
}

export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface ReadNoteResult {
  wrenId: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  updated: string;
  /** True when the on-disk file was newer than the index and we re-read it. */
  stale: boolean;
}

// --- Frontmatter parsing -----------------------------------------------------

// Wren writes a line-based YAML subset: `key: value`, with string values that
// need quoting emitted via JSON.stringify, and `tags` as an inline JSON array.
// We parse exactly that shape (not arbitrary YAML) to match the writer.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFrontmatter(text: string): ParsedNote {
  const fm: Record<string, unknown> = {};
  const m = FRONTMATTER_RE.exec(text);
  if (!m) return { frontmatter: fm, body: text };
  const body = text.slice(m[0].length);
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!key) continue;
    let raw = line.slice(idx + 1).trim();
    if (key === 'tags') {
      fm.tags = parseTagsValue(raw);
      continue;
    }
    if (raw.startsWith('"')) {
      try {
        raw = JSON.parse(raw);
      } catch {
        /* leave raw */
      }
    }
    fm[key] = raw;
  }
  return { frontmatter: fm, body };
}

function parseTagsValue(raw: string): string[] {
  if (typeof raw !== 'string' || !raw.startsWith('[')) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((t) => typeof t === 'string' && t.trim().length > 0);
  } catch {
    return [];
  }
}

function sha256Hex(text: string): string {
  return 'sha256-' + createHash('sha256').update(text, 'utf8').digest('hex');
}

// --- Catalog loading ---------------------------------------------------------

/**
 * Load `<notesDir>/.wren-index.json`. Validates schemaVersion (warns + best-
 * effort continues on mismatch). If the index is absent or unreadable, falls
 * back to a top-level `.md` scan that builds an equivalent in-memory catalog.
 */
export async function loadIndex(notesDir: string): Promise<Catalog> {
  const indexPath = path.join(notesDir, INDEX_FILE);
  let text: string;
  try {
    text = await fs.readFile(indexPath, 'utf8');
  } catch {
    log(`No ${INDEX_FILE} at ${notesDir} — falling back to a folder scan.`);
    return scanFolderCatalog(notesDir);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log(`${INDEX_FILE} is not valid JSON (${String(err)}) — falling back to a folder scan.`);
    return scanFolderCatalog(notesDir);
  }

  const catalog = parsed as Catalog;
  if (!catalog || !Array.isArray(catalog.notes)) {
    log(`${INDEX_FILE} has an unexpected shape — falling back to a folder scan.`);
    return scanFolderCatalog(notesDir);
  }
  if (catalog.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    log(
      `${INDEX_FILE} schemaVersion ${catalog.schemaVersion} != supported ${SUPPORTED_SCHEMA_VERSION}; ` +
        `attempting best-effort read.`
    );
  }
  // Normalize so downstream code can rely on arrays/strings being present.
  catalog.notes = catalog.notes.map(normalizeEntry);
  // Reconcile the main corpus with disk: an on-disk `.md` that the index omits
  // (e.g. a Drive-synced note that landed before the locally-synced
  // `.wren-index.json` caught up — index lag) is picked up here. Cheap: one
  // readdir + reads ONLY the files missing from the index (normally zero). The
  // index remains authoritative for notes it lists; this only ADDS stragglers.
  const mainCorpus = await reconcileMainCorpus(notesDir, catalog.notes);
  // Disk is the source of truth for staged notes: replace the index's inbox
  // entries with a live `_inbox/` scan. This makes a note created via
  // wren_create_note immediately readable + visible in get_index even before
  // Wren has regenerated its index. (Same spirit as the per-note staleness
  // re-read.)
  const inboxLive = await scanInboxNotes(notesDir);
  catalog.notes = [...mainCorpus, ...inboxLive];
  catalog.notes.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  catalog.count = catalog.notes.length;
  return catalog;
}

/**
 * Return the index's main-corpus (non-inbox) entries PLUS any top-level `.md`
 * files present on disk but absent from the index — a safety net for index lag
 * (the Drive-synced index briefly trailing the synced note files). Only the
 * missing files are read; if the dir can't be listed we trust the index as-is.
 */
async function reconcileMainCorpus(
  notesDir: string,
  indexNotes: NoteEntry[]
): Promise<NoteEntry[]> {
  const mainFromIndex = indexNotes.filter((n) => !n.inbox);
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(notesDir, { withFileTypes: true });
  } catch {
    return mainFromIndex; // can't reconcile — trust the index
  }
  const known = new Set(mainFromIndex.map((n) => n.file || n.path));
  const extras: NoteEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (RESERVED_NOTE_NAMES.has(name)) continue;
    if (known.has(name)) continue;
    const entry = await parseNoteFile(notesDir, name, name, false);
    if (entry) {
      log(`Index omits on-disk note ${name}; added from disk (index lag).`);
      extras.push(entry);
    }
  }
  return [...mainFromIndex, ...extras];
}

function normalizeEntry(e: Partial<NoteEntry>): NoteEntry {
  return {
    wrenId: e.wrenId ?? '',
    storageId: e.storageId ?? '',
    path: e.path ?? e.file ?? '',
    file: e.file ?? e.path ?? '',
    title: e.title ?? '',
    summary: e.summary ?? '',
    due: e.due ?? '',
    tags: Array.isArray(e.tags) ? e.tags : [],
    color: e.color ?? 'default',
    created: e.created ?? '',
    updated: e.updated ?? '',
    contentHash: e.contentHash ?? '',
    ...(e.inbox ? { inbox: true } : {}),
  };
}

/**
 * Fallback catalog: scan top-level `.md` files (skip reserved names; the scan is
 * top-level so the `_inbox/` subfolder is naturally excluded), parse each one's
 * frontmatter, and build the same per-note shape. contentHash is sha256 of the
 * body to match Wren's FS convention; path/file = the filename.
 */
export async function scanFolderCatalog(notesDir: string): Promise<Catalog> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(notesDir, { withFileTypes: true });
  } catch (err) {
    log(`Could not read notes dir ${notesDir}: ${String(err)}`);
    return emptyCatalog(true);
  }

  const notes: NoteEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (RESERVED_NOTE_NAMES.has(name)) continue;
    const entry = await parseNoteFile(notesDir, name, name, false);
    if (entry) notes.push(entry);
  }

  // Include live staged notes so a just-created note is visible/readable even
  // without a .wren-index.json. Inbox notes are still excluded from search/list
  // downstream (corpus()); they carry inbox:true.
  notes.push(...(await scanInboxNotes(notesDir)));

  notes.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    backend: 'fs',
    count: notes.length,
    notes,
    fromFallback: true,
  };
}

/**
 * Scan the `_inbox/` subfolder for staged `.md` notes. Returns [] when the
 * subfolder is absent. Each entry carries inbox:true and path `_inbox/<file>`.
 */
export async function scanInboxNotes(notesDir: string): Promise<NoteEntry[]> {
  const inboxDir = path.join(notesDir, INBOX_DIR);
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(inboxDir, { withFileTypes: true });
  } catch {
    return []; // no _inbox/ — fine
  }
  const notes: NoteEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (RESERVED_NOTE_NAMES.has(name)) continue;
    const rel = `${INBOX_DIR}/${name}`;
    const entry = await parseNoteFile(notesDir, rel, name, true);
    if (entry) notes.push(entry);
  }
  return notes;
}

/**
 * Parse one note file at `<notesDir>/<relPath>` into a NoteEntry. `file` is the
 * bare filename; `inbox` marks staged notes. Returns null if unreadable.
 */
async function parseNoteFile(
  notesDir: string,
  relPath: string,
  file: string,
  inbox: boolean
): Promise<NoteEntry | null> {
  try {
    const full = path.join(notesDir, relPath);
    const text = await fs.readFile(full, 'utf8');
    // Drive stream-mode placeholders can read as 0 bytes (or whitespace) until
    // hydrated. Skip them rather than emit a junk catalog entry (empty wrenId/
    // title) — they'll appear once Drive materializes the file. A read that
    // *throws* (also possible for placeholders) is handled by the catch below.
    if (text.trim().length === 0) {
      log(`Skipping empty/unhydrated note ${relPath} (0 bytes — Drive placeholder?).`);
      return null;
    }
    const { frontmatter, body } = parseFrontmatter(text);
    const stat = await fs.stat(full);
    const mtimeIso = stat.mtime.toISOString();
    return normalizeEntry({
      wrenId: str(frontmatter.id),
      storageId: relPath,
      path: relPath,
      file,
      title: str(frontmatter.title),
      summary: str(frontmatter.summary),
      due: str(frontmatter.due),
      tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : [],
      color: str(frontmatter.color) || 'default',
      created: str(frontmatter.created) || mtimeIso,
      updated: str(frontmatter.modified) || mtimeIso,
      contentHash: sha256Hex(body),
      ...(inbox ? { inbox: true } : {}),
    });
  } catch (err) {
    log(`Skipping unreadable note ${relPath}: ${String(err)}`);
    return null;
  }
}

function emptyCatalog(fromFallback = false): Catalog {
  return {
    schemaVersion: SUPPORTED_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    backend: 'fs',
    count: 0,
    notes: [],
    ...(fromFallback ? { fromFallback: true } : {}),
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// --- Query helpers -----------------------------------------------------------

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

/** Metadata-only projection returned by search (never includes bodies). */
export interface SearchHit {
  wrenId: string;
  title: string;
  tags: string[];
  summary: string;
  due: string;
  updated: string;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

// Corpus = non-inbox notes. Staged (_inbox/) notes are pending review and are
// excluded from search/list by default; they remain readable by wrenId.
function corpus(catalog: Catalog): NoteEntry[] {
  return catalog.notes.filter((n) => !n.inbox);
}

export interface SearchParams {
  query?: string;
  tag?: string;
  dueBefore?: string;
  limit?: number;
}

export function searchNotes(catalog: Catalog, params: SearchParams): SearchHit[] {
  const { query, tag, dueBefore } = params;
  const limit = clampLimit(params.limit);
  const q = query?.trim().toLowerCase();

  let hits = corpus(catalog);
  if (q) {
    hits = hits.filter(
      (n) =>
        (n.title || '').toLowerCase().includes(q) ||
        (n.summary || '').toLowerCase().includes(q)
    );
  }
  if (tag) {
    hits = hits.filter((n) => Array.isArray(n.tags) && n.tags.includes(tag));
  }
  if (dueBefore) {
    hits = hits.filter((n) => n.due && n.due <= dueBefore);
  }
  return hits.slice(0, limit).map(toSearchHit);
}

function toSearchHit(n: NoteEntry): SearchHit {
  return {
    wrenId: n.wrenId,
    title: n.title,
    tags: n.tags,
    summary: n.summary,
    due: n.due,
    updated: n.updated,
  };
}

export interface ListParams {
  tag?: string;
  limit?: number;
  cursor?: string;
}

export interface ListResult {
  items: SearchHit[];
  nextCursor?: string;
}

/**
 * Paginated metadata. `cursor` is an opaque offset token (base64 of the next
 * index). Inbox notes excluded, same as search.
 */
export function listNotes(catalog: Catalog, params: ListParams): ListResult {
  const limit = clampLimit(params.limit);
  let items = corpus(catalog);
  if (params.tag) {
    items = items.filter((n) => Array.isArray(n.tags) && n.tags.includes(params.tag as string));
  }
  const start = decodeCursor(params.cursor);
  const page = items.slice(start, start + limit);
  const end = start + page.length;
  const result: ListResult = { items: page.map(toSearchHit) };
  if (end < items.length) result.nextCursor = encodeCursor(end);
  return result;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const m = /^o:(\d+)$/.exec(decoded);
    if (m) return Number(m[1]);
  } catch {
    /* fall through */
  }
  log(`Ignoring malformed cursor "${cursor}".`);
  return 0;
}

// --- Read a single note ------------------------------------------------------

/**
 * Read a note by its logical wrenId. Works on any note in the catalog,
 * including staged `_inbox/` notes. Staleness: if the on-disk mtime is newer
 * than the index `updated`, the file is the source of truth — we re-read it and
 * flag `stale: true` (the returned `updated` is then the file mtime).
 */
export async function readNoteByWrenId(
  notesDir: string,
  catalog: Catalog,
  wrenId: string
): Promise<ReadNoteResult> {
  const entry = catalog.notes.find((n) => n.wrenId === wrenId);
  if (!entry) {
    throw new NoteNotFoundError(wrenId);
  }
  const rel = entry.path || entry.file;
  const full = path.join(notesDir, rel);
  let text: string;
  try {
    text = await fs.readFile(full, 'utf8');
  } catch (err) {
    // A Drive stream-mode placeholder can throw on read until hydrated. Surface
    // a clear, actionable error instead of a raw ENOENT (tools.ts turns this
    // into a clean tool error, never a crash).
    throw new NoteUnreadableError(wrenId, rel, err);
  }
  const { frontmatter, body } = parseFrontmatter(text);

  let updated = entry.updated;
  let stale = false;
  try {
    const stat = await fs.stat(full);
    const mtimeIso = stat.mtime.toISOString();
    if (entry.updated && mtimeIso > entry.updated) {
      stale = true;
      updated = mtimeIso;
      log(`Note ${wrenId} on disk (${mtimeIso}) is newer than index (${entry.updated}); used disk copy.`);
    } else if (!entry.updated) {
      updated = mtimeIso;
    }
  } catch {
    /* stat failure is non-fatal; keep index updated */
  }

  return {
    wrenId,
    title: str(frontmatter.title) || entry.title,
    frontmatter,
    body,
    updated,
    stale,
  };
}

export class NoteNotFoundError extends Error {
  constructor(wrenId: string) {
    super(`No note with wrenId "${wrenId}" in the catalog.`);
    this.name = 'NoteNotFoundError';
  }
}

export class NoteUnreadableError extends Error {
  constructor(wrenId: string, rel: string, cause?: unknown) {
    super(
      `Could not read note "${wrenId}" at "${rel}". If you use Google Drive ` +
        `for Desktop, the file may be online-only (stream mode) and not yet ` +
        `hydrated — set the Wren Notes folder to "mirror" mode. (${String(cause)})`
    );
    this.name = 'NoteUnreadableError';
  }
}

// --- Index summary -----------------------------------------------------------

export interface IndexSummary {
  schemaVersion: number;
  generatedAt: string;
  backend: string;
  count: number;
  fromFallback?: boolean;
  /** Set when the per-note detail was trimmed for size. */
  summarized?: boolean;
  notes: Array<Partial<NoteEntry>>;
}

/**
 * The whole catalog for `wren_get_index`. For corpora larger than
 * INDEX_SUMMARY_THRESHOLD, drop the heavier per-note fields (summary/tags) so a
 * single call can't blow the context budget; the slimmed entries still carry
 * the identifiers + dates needed to then search/read specific notes.
 */
export function getIndexSummary(catalog: Catalog): IndexSummary {
  const base = {
    schemaVersion: catalog.schemaVersion,
    generatedAt: catalog.generatedAt,
    backend: catalog.backend,
    count: catalog.count,
    ...(catalog.fromFallback ? { fromFallback: true } : {}),
  };
  if (catalog.notes.length > INDEX_SUMMARY_THRESHOLD) {
    return {
      ...base,
      summarized: true,
      notes: catalog.notes.map((n) => ({
        wrenId: n.wrenId,
        title: n.title,
        path: n.path,
        due: n.due,
        updated: n.updated,
        ...(n.inbox ? { inbox: true } : {}),
      })),
    };
  }
  return { ...base, notes: catalog.notes };
}
