// note-editor.ts
//
// The v2 write layer: modify EXISTING notes (update / append / set_tags),
// soft-delete to `.trash/`, and promote an `_inbox/` note into the live corpus.
// Pairs with src/note-writer.ts (which CREATES new notes); the create path lives
// there, the mutate/move/delete paths live here.
//
// SAFETY MODEL (non-negotiable — KB modules 03/04, see the build brief):
//   1. Read-first + optimistic concurrency. Every modify takes the caller's
//      `expectedContentHash` (the `contentHash` they last read via
//      wren_read_note). We re-read the file, recompute the BODY hash live, and
//      REJECT with ConflictError if it differs — never a blind overwrite. The
//      hash is Wren's FS contentHash convention (sha256 of the body), computed
//      both on read and on write so it is correct even on the Drive backend.
//   2. dry_run returns the intended change (a diff) without touching disk.
//   3. Soft-delete only — wren_delete_note MOVES the file to `.trash/`, never
//      unlinks the sole copy, and requires confirm:true at the tool layer.
//   4. Path-traversal safe — every resolved path is asserted to stay inside the
//      configured notes dir; `..`/absolute escapes are rejected.
//   5. Note bodies are untrusted DATA. This module only ever treats a body as
//      text to read/patch — it never parses instructions out of a body.
//
// INDEX RECONCILIATION = MODEL A (Wren re-indexes). This module writes `.md`
// files ONLY and never touches `.wren-index.json` (the PWA owns that frozen
// contract and regenerates it on its next save/launch). The MCP's own reads
// self-heal via the existing fallback scan + mtime staleness re-read in
// notes-source.ts, so reads stay correct in the gap. See README / CLAUDE.md.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type Catalog,
  parseFrontmatter,
  bodyContentHash,
  canonicalBody,
  NoteNotFoundError,
} from './notes-source.js';
import {
  serializeNoteFile,
  isValidNamespacedTag,
  buildNoteFilename,
  uniqueNoteName,
  INBOX_PREFIX,
  PROVENANCE_KEYS,
  type Actor,
} from './note-writer.js';

/** Top-level subfolder where soft-deleted notes are parked (MCP-only). */
export const TRASH_DIR = '.trash';

/**
 * Raised when the on-disk note changed since the caller read it (its live body
 * hash != the supplied expectedContentHash). The tool layer surfaces this as a
 * clear, non-destructive conflict rather than overwriting the other change.
 */
export class WriteConflictError extends Error {
  constructor(
    readonly wrenId: string,
    readonly expected: string,
    readonly actual: string
  ) {
    super(
      `Write conflict on note "${wrenId}": the note changed on disk since you ` +
        `read it. You passed expected_content_hash "${expected}" but the current ` +
        `content hash is "${actual}". Re-read the note with wren_read_note and ` +
        `retry the write with the fresh contentHash.`
    );
    this.name = 'WriteConflictError';
  }
}

/** Raised when a tag fails the namespaced-tag validation. */
export class InvalidTagError extends Error {
  constructor(readonly tags: string[]) {
    super(
      `Invalid tag(s): ${tags.map((t) => JSON.stringify(t)).join(', ')}. ` +
        `Tags must be "namespace:value" (e.g. "status:todo"), trimmed, with no ` +
        `newlines or double-quotes, and a non-empty namespace AND value.`
    );
    this.name = 'InvalidTagError';
  }
}

/** Raised when an operation requires an `_inbox/` note but got a corpus note. */
export class NotAnInboxNoteError extends Error {
  constructor(readonly wrenId: string) {
    super(`Note "${wrenId}" is not a staged _inbox/ note, so it cannot be promoted to the corpus.`);
    this.name = 'NotAnInboxNoteError';
  }
}

/** A note's full parsed frontmatter + body, plus where it lives on disk. */
interface LoadedNote {
  wrenId: string;
  /** Relative path from notes root, e.g. "2026-06-01 - Note.md" or "_inbox/…". */
  rel: string;
  /** Absolute path on disk (already asserted inside notesDir). */
  full: string;
  inbox: boolean;
  title: string;
  created: string;
  modified: string;
  color: string;
  due: string;
  summary: string;
  tags: string[];
  body: string;
  /** Existing provenance: who created the note ('' when the note predates it). */
  createdBy: string;
  /** sha256-<hex> of the body as just read — the live contentHash. */
  contentHash: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * The created_by actor to persist on a MODIFY. Preserve an existing created_by
 * (never clobber it — v2.1); when absent, the note was authored in Wren by a
 * human, so default to 'human'.
 */
function preservedCreatedBy(existing: string): Actor {
  return existing === 'ai' ? 'ai' : 'human';
}

/**
 * Resolve & assert a relative note path stays inside the notes dir, then return
 * the absolute path. Rejects `..` traversal and absolute escapes.
 */
function safeResolve(notesDir: string, rel: string): string {
  const root = path.resolve(notesDir);
  const full = path.resolve(root, rel);
  const relCheck = path.relative(root, full);
  if (relCheck === '' || relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error(`Refusing to operate outside the notes folder: "${rel}".`);
  }
  return full;
}

/**
 * Read an existing note by wrenId from the live file (not the index): locate it
 * in the catalog, resolve a traversal-safe path, read + parse it, and compute
 * the live body contentHash. Throws NoteNotFoundError if absent.
 */
export async function loadNote(notesDir: string, catalog: Catalog, wrenId: string): Promise<LoadedNote> {
  const entry = catalog.notes.find((n) => n.wrenId === wrenId);
  if (!entry) throw new NoteNotFoundError(wrenId);
  const rel = entry.path || entry.file;
  const full = safeResolve(notesDir, rel);
  const text = await fs.readFile(full, 'utf8');
  const { frontmatter, body: rawBody } = parseFrontmatter(text);
  const body = canonicalBody(rawBody);
  return {
    wrenId,
    rel,
    full,
    inbox: !!entry.inbox || rel.startsWith(INBOX_PREFIX),
    title: str(frontmatter.title) || entry.title,
    created: str(frontmatter.created) || entry.created,
    modified: str(frontmatter.modified) || entry.updated,
    color: str(frontmatter.color) || 'default',
    due: str(frontmatter.due) || entry.due,
    summary: str(frontmatter.summary) || entry.summary,
    tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : entry.tags,
    body,
    createdBy: str(frontmatter[PROVENANCE_KEYS.createdBy]),
    contentHash: bodyContentHash(body),
  };
}

/** Enforce the optimistic-concurrency gate. */
function assertNoConflict(note: LoadedNote, expectedContentHash: string): void {
  if (note.contentHash !== expectedContentHash) {
    throw new WriteConflictError(note.wrenId, expectedContentHash, note.contentHash);
  }
}

/**
 * Atomically replace a file's contents: write a sibling temp file then rename
 * over the target, so a crash mid-write never leaves a half-written note.
 */
async function atomicWrite(full: string, text: string): Promise<void> {
  const tmp = `${full}.wren-mcp.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, full);
}

/** Build a result payload shared by the modify tools. */
function modifyResult(note: LoadedNote, newBody: string, newRel: string, modifiedIso: string) {
  return {
    wrenId: note.wrenId,
    path: newRel,
    updated: modifiedIso,
    /** New body hash — pass as expected_content_hash for a follow-on edit. */
    contentHash: bodyContentHash(newBody),
    written: true as const,
  };
}

// --- Diff (dry_run) ----------------------------------------------------------

export interface DryRunDiff {
  wrenId: string;
  dryRun: true;
  /** Frontmatter field changes, before → after (only changed fields). */
  fields: Record<string, { before: string; after: string }>;
  /** Unified-ish line diff of the body (empty when the body is unchanged). */
  bodyDiff: string;
  contentHashBefore: string;
  contentHashAfter: string;
}

/**
 * Minimal, deterministic line diff: trim the common leading/trailing lines and
 * render the differing middle as `- old` / `+ new` blocks. Enough for a human/
 * agent to confirm an intended change without pulling in a diff library.
 */
export function lineDiff(before: string, after: string): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA + 1).map((l) => `- ${l}`);
  const added = b.slice(start, endB + 1).map((l) => `+ ${l}`);
  return [...removed, ...added].join('\n');
}

function buildDiff(
  note: LoadedNote,
  next: { title: string; due: string; summary: string; tags: string[]; body: string },
  newBody: string
): DryRunDiff {
  const fields: Record<string, { before: string; after: string }> = {};
  const addField = (name: string, before: string, after: string) => {
    if (before !== after) fields[name] = { before, after };
  };
  addField('title', note.title, next.title);
  addField('due', note.due, next.due);
  addField('summary', note.summary, next.summary);
  addField('tags', JSON.stringify(note.tags), JSON.stringify(next.tags));
  return {
    wrenId: note.wrenId,
    dryRun: true,
    fields,
    bodyDiff: lineDiff(note.body, newBody),
    contentHashBefore: note.contentHash,
    contentHashAfter: bodyContentHash(newBody),
  };
}

// --- update ------------------------------------------------------------------

export interface UpdateNoteInput {
  wrenId: string;
  body?: string;
  title?: string;
  due?: string;
  expectedContentHash: string;
  dryRun?: boolean;
}

/**
 * Patch an existing note's body and/or frontmatter (title, due). Read-first +
 * optimistic-concurrency gated. Preserves all other frontmatter (color, summary,
 * tags, created) and bumps `modified`. dry_run returns a diff without writing.
 */
export async function updateNote(
  notesDir: string,
  catalog: Catalog,
  input: UpdateNoteInput,
  now: string = new Date().toISOString()
): Promise<DryRunDiff | ReturnType<typeof modifyResult>> {
  const note = await loadNote(notesDir, catalog, input.wrenId);
  assertNoConflict(note, input.expectedContentHash);

  const next = {
    title: input.title ?? note.title,
    due: input.due ?? note.due,
    summary: note.summary,
    tags: note.tags,
    body: input.body ?? note.body,
  };

  if (input.dryRun) return buildDiff(note, next, next.body);

  const text = serializeNoteFile({
    wrenId: note.wrenId,
    title: next.title,
    createdIso: note.created,
    modifiedIso: now,
    color: note.color,
    body: next.body,
    due: next.due,
    summary: next.summary,
    tags: next.tags,
    createdBy: preservedCreatedBy(note.createdBy),
    lastEditedBy: 'ai',
    lastEdited: now,
  });
  await atomicWrite(note.full, text);
  return modifyResult(note, next.body, note.rel, now);
}

// --- append ------------------------------------------------------------------

export interface AppendNoteInput {
  wrenId: string;
  text: string;
  expectedContentHash: string;
  dryRun?: boolean;
}

/** Join the existing body and appended text with a blank-line separator. */
export function joinAppended(body: string, text: string): string {
  if (!body.trim()) return text;
  return `${body.replace(/\s+$/, '')}\n\n${text}`;
}

/**
 * Append text to a note's body (lower-risk additive write). Same read-first +
 * concurrency gate as updateNote. dry_run returns a diff without writing.
 */
export async function appendToNote(
  notesDir: string,
  catalog: Catalog,
  input: AppendNoteInput,
  now: string = new Date().toISOString()
): Promise<DryRunDiff | ReturnType<typeof modifyResult>> {
  const note = await loadNote(notesDir, catalog, input.wrenId);
  assertNoConflict(note, input.expectedContentHash);

  const newBody = joinAppended(note.body, input.text);
  const next = { title: note.title, due: note.due, summary: note.summary, tags: note.tags, body: newBody };

  if (input.dryRun) return buildDiff(note, next, newBody);

  const text = serializeNoteFile({
    wrenId: note.wrenId,
    title: note.title,
    createdIso: note.created,
    modifiedIso: now,
    color: note.color,
    body: newBody,
    due: note.due,
    summary: note.summary,
    tags: note.tags,
    createdBy: preservedCreatedBy(note.createdBy),
    lastEditedBy: 'ai',
    lastEdited: now,
  });
  await atomicWrite(note.full, text);
  return modifyResult(note, newBody, note.rel, now);
}

// --- set_tags ----------------------------------------------------------------

export interface SetTagsInput {
  wrenId: string;
  add?: string[];
  remove?: string[];
  expectedContentHash: string;
  dryRun?: boolean;
}

/** Apply add/remove to a tag list: remove first, then append new (deduped, order-preserving). */
export function applyTagChanges(current: string[], add: string[], remove: string[]): string[] {
  const removeSet = new Set(remove.map((t) => t.trim()));
  const out = current.filter((t) => !removeSet.has(t.trim()));
  const have = new Set(out.map((t) => t.trim()));
  for (const t of add) {
    const tt = t.trim();
    if (!have.has(tt)) {
      out.push(tt);
      have.add(tt);
    }
  }
  return out;
}

/**
 * Add and/or remove namespaced tags on a note. Validates every ADDED tag as
 * `namespace:value` (rejects the whole call if any is invalid — never invents a
 * namespace). Read-first + concurrency gated. NOTE: the gate hashes the BODY
 * (Wren's contentHash convention); a tag change does not alter the body hash, so
 * concurrent tag-only edits are last-write-wins, matching Wren's own model.
 */
export async function setTags(
  notesDir: string,
  catalog: Catalog,
  input: SetTagsInput,
  now: string = new Date().toISOString()
): Promise<DryRunDiff | (ReturnType<typeof modifyResult> & { tags: string[] })> {
  const add = (input.add ?? []).filter((t) => typeof t === 'string');
  const remove = (input.remove ?? []).filter((t) => typeof t === 'string');
  const invalid = add.filter((t) => !isValidNamespacedTag(t));
  if (invalid.length > 0) throw new InvalidTagError(invalid);

  const note = await loadNote(notesDir, catalog, input.wrenId);
  assertNoConflict(note, input.expectedContentHash);

  const newTags = applyTagChanges(note.tags, add, remove);
  const next = { title: note.title, due: note.due, summary: note.summary, tags: newTags, body: note.body };

  if (input.dryRun) return buildDiff(note, next, note.body);

  const text = serializeNoteFile({
    wrenId: note.wrenId,
    title: note.title,
    createdIso: note.created,
    modifiedIso: now,
    color: note.color,
    body: note.body,
    due: note.due,
    summary: note.summary,
    tags: newTags,
    createdBy: preservedCreatedBy(note.createdBy),
    lastEditedBy: 'ai',
    lastEdited: now,
  });
  await atomicWrite(note.full, text);
  return { ...modifyResult(note, note.body, note.rel, now), tags: newTags };
}

// --- soft delete -------------------------------------------------------------

export interface SoftDeleteResult {
  wrenId: string;
  softDeleted: true;
  originalPath: string;
  trashedPath: string;
}

/**
 * Soft-delete: MOVE the note file into `<notesDir>/.trash/` (created on demand),
 * never unlink the only copy. Wren ignores `.trash/` (its scans are top-level +
 * `_inbox/` only), so the note vanishes from Wren as if deleted while the file
 * survives for recovery. The tool layer requires confirm:true before calling.
 */
export async function softDeleteNote(
  notesDir: string,
  catalog: Catalog,
  wrenId: string
): Promise<SoftDeleteResult> {
  const note = await loadNote(notesDir, catalog, wrenId);
  const trashDirFull = safeResolve(notesDir, TRASH_DIR);
  await fs.mkdir(trashDirFull, { recursive: true });

  const baseName = path.basename(note.rel);
  const targetName = await uniqueNoteName(baseName, async (name) => {
    try {
      await fs.access(path.join(trashDirFull, name));
      return true;
    } catch {
      return false;
    }
  });
  const targetFull = safeResolve(notesDir, `${TRASH_DIR}/${targetName}`);

  try {
    await fs.rename(note.full, targetFull);
  } catch (err) {
    // Cross-device rename (EXDEV) — fall back to copy + unlink.
    if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
      await fs.copyFile(note.full, targetFull);
      await fs.unlink(note.full);
    } else {
      throw err;
    }
  }

  return {
    wrenId,
    softDeleted: true,
    originalPath: note.rel,
    trashedPath: `${TRASH_DIR}/${targetName}`,
  };
}

// --- move to corpus ----------------------------------------------------------

export interface MoveToCorpusResult {
  wrenId: string;
  fromPath: string;
  path: string;
  target: 'corpus';
}

/**
 * Promote a staged `_inbox/` note into the live corpus (root): write a clean,
 * collision-free copy at the root (content/frontmatter byte-identical — a move,
 * not an edit), then remove the inbox original (write-new-then-delete-old so a
 * mid-failure never loses the note). Errors if the note isn't an inbox note.
 */
export async function moveToCorpus(
  notesDir: string,
  catalog: Catalog,
  wrenId: string,
  now: string = new Date().toISOString()
): Promise<MoveToCorpusResult> {
  const note = await loadNote(notesDir, catalog, wrenId);
  if (!note.inbox) throw new NotAnInboxNoteError(wrenId);

  const fullText = await fs.readFile(note.full, 'utf8');
  const desired = buildNoteFilename(note.created || now, note.title);
  const targetName = await uniqueNoteName(desired, async (name) => {
    try {
      await fs.access(safeResolve(notesDir, name));
      return true;
    } catch {
      return false;
    }
  });
  const targetFull = safeResolve(notesDir, targetName);

  // Exclusive write so we never clobber an existing corpus file, then delete the
  // inbox original only after the new file is safely on disk.
  await fs.writeFile(targetFull, fullText, { encoding: 'utf8', flag: 'wx' });
  await fs.unlink(note.full);

  return { wrenId, fromPath: note.rel, path: targetName, target: 'corpus' };
}

// --- restore from trash ------------------------------------------------------

export interface RestoreResult {
  wrenId: string;
  restored: true;
  /** Path the note was recovered FROM, e.g. ".trash/2026-06-01 - X.md". */
  fromTrashPath: string;
  /** Collision-free path it was restored TO, relative to the notes root. */
  path: string;
}

/**
 * Restore a soft-deleted note: find the file in `<notesDir>/.trash/` whose
 * frontmatter `id` matches `wrenId`, move it back into the live corpus root under
 * a collision-free name, and remove the trash copy (write-new-then-delete-old, so
 * a mid-failure never loses the note). Content/frontmatter are byte-identical — a
 * relocation, not an edit, so provenance is untouched. The note reappears in Wren
 * on its next index refresh. This closes the soft-delete loop: a note sent to
 * `.trash/` by wren_delete_note is recoverable without leaving Claude.
 *
 * Trashed notes are NOT in the catalog (both Wren and the MCP skip `.trash/`), so
 * this scans the trash folder directly rather than going through loadNote.
 * Throws NoteNotFoundError if no trashed note carries that id.
 */
export async function restoreNote(
  notesDir: string,
  wrenId: string,
  now: string = new Date().toISOString()
): Promise<RestoreResult> {
  const trashDirFull = safeResolve(notesDir, TRASH_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(trashDirFull);
  } catch {
    // No .trash/ folder => nothing to restore.
    throw new NoteNotFoundError(wrenId);
  }

  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const trashRel = `${TRASH_DIR}/${name}`;
    const trashFull = safeResolve(notesDir, trashRel);

    let text: string;
    try {
      text = await fs.readFile(trashFull, 'utf8');
    } catch {
      continue; // unreadable entry — skip, keep scanning
    }

    const { frontmatter } = parseFrontmatter(text);
    if (str(frontmatter.id) !== wrenId) continue;

    const created = str(frontmatter.created) || now;
    const desired = buildNoteFilename(created, str(frontmatter.title));
    const targetName = await uniqueNoteName(desired, async (candidate) => {
      try {
        await fs.access(safeResolve(notesDir, candidate));
        return true;
      } catch {
        return false;
      }
    });
    const targetFull = safeResolve(notesDir, targetName);

    // Exclusive write so we never clobber an existing corpus file, then remove
    // the trash copy only after the restored file is safely on disk.
    await fs.writeFile(targetFull, text, { encoding: 'utf8', flag: 'wx' });
    await fs.unlink(trashFull);

    return { wrenId, restored: true, fromTrashPath: trashRel, path: targetName };
  }

  throw new NoteNotFoundError(wrenId);
}
