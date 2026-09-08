/**
 * @notrealstudio/nr-chat-store — storage driver contract (spec §5).
 *
 * Fully async: a driver may be cloud-backed (chub, opencode, dreams, any HTTP).
 * Optional method ↔ capability: a read-only driver = list/load only — legal.
 * The mutation set is the minimum derived from the protocol's messages
 * operations; forking/regenerate = `appendNode` with an explicit `parent` +
 * `setActiveLeaf`, there's no separate primitive.
 *
 * Generation and process-management are out of contract (not storage).
 */

import type { Part, SessionInfo, SessionModel, StoreNode, NodeInput } from './model.js'

/**
 * Record patch (spec §5). `text` is the protocol §4.2 shortcut: the first
 * text-part is replaced, the rest of the parts are kept. `ifHash` is an OPTIONAL
 * optimistic guard: when supplied, a mismatch → `conflict` error (silent
 * overwrite of someone else's edit is refused); when omitted, the edit proceeds
 * unconditionally. It is a guard the caller may opt into, not a mandatory field.
 */
export interface NodePatch {
  parts?: Part[]
  text?: string
  ifHash?: string
}

export interface SessionStore {
  capabilities(): Promise<StoreCapabilities>
  list(opts?: { limit?: number; cursor?: string }): Promise<{ sessions: SessionInfo[]; cursor?: string }>
  load(id: string): Promise<SessionModel>
  create(opts?: { id?: string; info?: Partial<SessionInfo> }): Promise<SessionInfo>
  delete?(id: string): Promise<void>
  /** Change a session's title (a primitive, separate from sessionMeta). capability: rename. */
  rename?(id: string, title: string): Promise<void>

  /** Append a node. `parent` unset → active leaf (§5). */
  appendNode(sid: string, node: NodeInput): Promise<StoreNode>
  editNode?(sid: string, nid: string, patch: NodePatch): Promise<StoreNode>
  /** Children are re-parented onto the deleted node's parent (§5). */
  deleteNode?(sid: string, nid: string): Promise<void>
  hideNode?(sid: string, nid: string, hidden: boolean): Promise<void>
  /** Swipe primitive: make `nid` the active leaf. */
  setActiveLeaf?(sid: string, nid: string): Promise<void>
  /** New session from the active path (up to and including `atNodeId`). */
  forkCopy?(sid: string, atNodeId?: string): Promise<SessionInfo>

  /**
   * Open session-meta dictionary (protocol `sessionMeta`). capability: sessionMeta.
   *
   * `patch` is the driver's own shallow merge; the protocol's patch rule (nested
   * `prompt`, `null` deletes a key) lives one layer up, in the backend, because
   * it must be identical across every driver. That layer needs to write a whole
   * document, deletions included — which `patch` cannot express: hence `set`.
   * A driver without `set` cannot honour key deletion, and the backend says so.
   */
  meta?: {
    get(sid: string): Promise<Record<string, unknown>>
    patch(sid: string, p: Record<string, unknown>): Promise<void>
    /** Replace the whole document (the only way to drop a key). */
    set?(sid: string, doc: Record<string, unknown>): Promise<void>
  }
  assets?: {
    put(sid: string, name: string, data: Uint8Array, mime?: string): Promise<{ ref: string }>
  }
  version?(sid: string): Promise<string>
  close?(): Promise<void>
}

/**
 * A driver's declared capabilities. backends-spec §2 rule verbatim: an optional
 * method is present ⟺ the corresponding capability is true.
 */
export interface StoreCapabilities {
  edits?: { edit?: boolean; delete?: boolean; hide?: boolean }
  swipes?: boolean // = setActiveLeaf
  fork?: boolean // = forkCopy
  rename?: boolean // = rename (title-change primitive)
  assets?: boolean
  sessionMeta?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Contract errors
// ────────────────────────────────────────────────────────────────────────────

/**
 * The record's body changed under the edit (`ifHash` didn't match). The
 * `conflict` code is normative: for local drivers it's optimistic concurrency
 * against oneself, for remote — against others' edits between load and editNode.
 */
export class StoreConflictError extends Error {
  readonly code = 'conflict'
  constructor(nid: string) {
    super(`nr-chat-store: record ${nid} changed — ifHash did not match`)
    this.name = 'StoreConflictError'
  }
}

/** A record was addressed that doesn't exist in the session. */
export class StoreNodeNotFound extends Error {
  readonly code = 'not_found'
  constructor(nid: string) {
    super(`nr-chat-store: record ${nid} not found in session`)
    this.name = 'StoreNodeNotFound'
  }
}

/** A session was requested that doesn't exist in the store. */
export class StoreSessionNotFound extends Error {
  readonly code = 'not_found'
  constructor(sid: string) {
    super(`nr-chat-store: session ${sid} not found in store`)
    this.name = 'StoreSessionNotFound'
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Shared across drivers
// ────────────────────────────────────────────────────────────────────────────

/**
 * A malformed id/name that a driver refuses to use as a filesystem path
 * component. Distinct from `not_found`: the input never had a chance of being
 * valid (path traversal, empty, control chars).
 */
export class StoreInvalidId extends Error {
  readonly code = 'invalid_id'
  constructor(kind: string, value: string) {
    super(`nr-chat-store: invalid ${kind} ${JSON.stringify(value)} — must match /^[A-Za-z0-9._-]+$/ and not be "."/".."`)
    this.name = 'StoreInvalidId'
  }
}

/** Allowed characters for any id/name that reaches a filesystem path. */
const SAFE_ID = /^[A-Za-z0-9._-]+$/

/**
 * Path-traversal guard for identifiers (spec §1): a session id or node id becomes
 * a filesystem path component, so it must be a single safe ASCII segment —
 * `/^[A-Za-z0-9._-]+$/`, not `.`/`..`. Ids are machine-minted, so the strict
 * alphabet costs nothing. Returns the id (for inline use), throws `StoreInvalidId`
 * otherwise. `kind` names the guarded thing in the error.
 */
export function assertSafeId(value: string, kind = 'id'): string {
  if (typeof value !== 'string' || value === '.' || value === '..' || !SAFE_ID.test(value)) {
    throw new StoreInvalidId(kind, String(value))
  }
  return value
}

/**
 * Path-traversal guard for asset names (spec §1). An asset name is a human
 * filename (attachments legitimately carry Unicode — `отчёт.pdf`), so — unlike an
 * id — it is NOT restricted to ASCII. It must still be a single path segment: no
 * separators (`/` or `\`), no `.`/`..`, no empty, no control chars. Traversal is
 * blocked here; the driver's `resolve`-containment is the second line. Throws
 * `StoreInvalidId` on violation.
 */
export function assertSafeAssetName(name: string): string {
  const hasControl = typeof name === 'string' && [...name].some((ch) => ch.charCodeAt(0) < 0x20)
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..' || /[/\\]/.test(name) || hasControl) {
    throw new StoreInvalidId('asset name', String(name))
  }
  return name
}

/**
 * Honest local pagination for `list` (spec §5): apply an opaque cursor + limit
 * over an already-ordered array and hand back the next cursor when more remain.
 * The cursor is an opaque offset token (drivers must not construct it by hand).
 * No `limit` → everything from the cursor, no next page.
 */
export function paginate<T>(items: T[], opts?: { limit?: number; cursor?: string }): { items: T[]; cursor?: string } {
  const start = decodeCursor(opts?.cursor)
  if (opts?.limit === undefined) return { items: items.slice(start) }
  const limit = Math.max(0, Math.floor(opts.limit))
  const end = start + limit
  const out: { items: T[]; cursor?: string } = { items: items.slice(start, end) }
  if (end < items.length) out.cursor = encodeCursor(end)
  return out
}

/** Opaque cursor ⇄ offset. Opaque so callers treat it as a token, not an index. */
function encodeCursor(offset: number): string {
  return Buffer.from(`nrs:${offset}`, 'utf-8').toString('base64')
}
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  try {
    const m = /^nrs:(\d+)$/.exec(Buffer.from(cursor, 'base64').toString('utf-8'))
    return m ? Number(m[1]) : 0
  } catch {
    return 0
  }
}

/** `NodeInput` → `Part[]`: the full set, or the text shortcut (empty → one text). */
export function partsOf(input: NodeInput): Part[] {
  if (input.parts) return input.parts
  return [{ type: 'text', text: input.text ?? '' }]
}

/**
 * The patch's `text` shortcut (§5): replace the text-parts with a single
 * text-part, keep the rest. If there's no text-part at all, the new one goes to
 * the end.
 */
export function replaceTextParts(parts: Part[], text: string): Part[] {
  const out: Part[] = []
  let placed = false
  for (const part of parts) {
    if (part.type !== 'text') {
      out.push(part)
      continue
    }
    if (!placed) {
      out.push({ type: 'text', text })
      placed = true
    }
  }
  if (!placed) out.push({ type: 'text', text })
  return out
}
