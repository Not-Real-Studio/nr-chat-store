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
 * text-part is replaced, the rest of the parts are kept. `ifHash` is mandatory
 * conflict detection: mismatch → `conflict` error, silent overwrite is
 * forbidden.
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

  meta?: {
    get(sid: string): Promise<Record<string, unknown>>
    patch(sid: string, p: Record<string, unknown>): Promise<void>
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
