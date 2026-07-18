/**
 * @notrealstudio/nr-chat-store — neutral chat-session model (spec §3).
 *
 * Message anatomy (Part/Message/SessionInfo/…) moved here from
 * nr-ui-protocol §2.1–2.3 **as-is**, no semantic edits: this is the shared
 * reality of storage and wire, and its home is the lower layer. The protocol is
 * now a client: it imports these types and re-exports them (existing imports
 * don't break), keeping only the wire for itself (RunEvent, Capabilities,
 * Envelope, SSE).
 *
 * Canon: S:\skills\nr-system.dev\specs\chat-store-spec.md
 */

// ────────────────────────────────────────────────────────────────────────────
// Session (protocol §2.1)
// ────────────────────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string
  title?: string
  createdAt?: string // ISO
  updatedAt?: string // ISO
  messageCount?: number
  // presentation (capability: catalog)
  botId?: string
  botName?: string
  botAvatar?: string // URL/ref
  accentColor?: string
  participants?: Participant[]
  // forking (capability: fork)
  parentSessionId?: string
  forkMessageId?: string
}

export interface Participant {
  id: string
  type: 'human' | 'ai'
  name: string
  avatar?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Message (protocol §2.2)
// ────────────────────────────────────────────────────────────────────────────

export interface MessageFlags {
  hidden?: boolean // visible in UI, invisible to LLM
  frozen?: boolean // always in context
  injected?: boolean // inserted by the system, not shown in the feed
}

export interface MessageMeta {
  createdAt?: string
  model?: string
  usage?: Usage
}

export interface Message {
  id: string // opaque handle; a driver may hand out positional ('pos:N')
  role: string // 'user' | 'assistant' | 'system' | 'tool' | 'narrator' | ...
  name?: string // display name (group chat)
  parts: Part[] // primary content
  flags?: MessageFlags
  swipes?: { active: number; count: number } // capability: swipes
  hash?: string // optimistic concurrency for edit
  meta?: MessageMeta
}

export interface Usage {
  input: number
  output: number
}

// ────────────────────────────────────────────────────────────────────────────
// Part — closed core of types + escape hatch (custom) (protocol §2.3)
// ────────────────────────────────────────────────────────────────────────────

export interface TextPart {
  type: 'text'
  text: string
}

export interface ThinkingPart {
  type: 'thinking'
  text: string
  meta?: { signature?: string }
}

export interface ToolUsePart {
  type: 'tool_use'
  data: unknown
  meta: { callId: string; name: string }
}

export interface ToolResultPart {
  type: 'tool_result'
  data?: unknown
  text?: string
  meta: { callId: string; name?: string; error?: boolean }
}

export interface FilePart {
  type: 'file'
  meta: { name: string; mime?: string; url?: string; ref?: string }
}

export interface ImagePart {
  type: 'image'
  meta: { mime?: string; url?: string; ref?: string; alt?: string }
}

export interface ErrorPart {
  type: 'error'
  text: string
  meta?: { code?: string }
}

export interface CustomPart {
  type: 'custom'
  data?: unknown
  text?: string
  meta: { hint: string; [k: string]: unknown } // hint — a cue for the renderer
}

/** Closed core of part types. `custom` is the escape hatch (closedness preserved). */
export type Part =
  | TextPart
  | ThinkingPart
  | ToolUsePart
  | ToolResultPart
  | FilePart
  | ImagePart
  | ErrorPart
  | CustomPart

/** Literal `type` values for known parts (for guards). */
export type KnownPartType = Part['type']

/**
 * Escape hatch: an unknown part type. Arrives under graceful degradation —
 * rendered via a fallback, the client doesn't crash. No fields guaranteed
 * except `type`.
 */
export interface UnknownPart {
  type: string
  [k: string]: unknown
}

/** Any part: known or opaque. */
export type AnyPart = Part | UnknownPart

// ────────────────────────────────────────────────────────────────────────────
// Session structure (spec §3)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Neutral session: info + open meta + nodes in storage append-order. `nodes` is
 * the whole tree, not the active path: projections (`toHistory`, `toThread`)
 * pick the slice they need out of it (§4).
 */
export interface SessionModel {
  info: SessionInfo // id required
  meta?: Record<string, unknown> // sessionMeta (open dictionary)
  nodes: StoreNode[] // storage append-order
}

/**
 * Storage node (spec §3). **Parent is always explicit** — the common
 * denominator. Chain default ("no parent = previous node") and other encoding
 * shortcuts live in the drivers: they expand them on load and fold them back on
 * write.
 */
export interface StoreNode {
  /**
   * Session-scoped stable id. A driver without native ids hands out positional
   * ones (`pos:N`).
   */
  id: string
  /** EXPLICIT. `null` = root. A broken ref is treated as a root (§4). */
  parent: string | null
  role: string
  name?: string
  parts: Part[]
  flags?: MessageFlags
  /** Including model/usage/createdAt and driver-specifics. */
  meta?: Record<string, unknown>
}

/**
 * Write-mutation input (spec §5): parts (or text shortcut), role, explicit
 * parent. `parent` unset → the driver attaches to the active leaf.
 */
export interface NodeInput {
  /**
   * Desired stable node id (spec §5, id-first). The driver honors it as the
   * record's id, or generates its own when absent — so the caller knows the id
   * before the write (run-lifecycle: the assistant's id in events == the
   * record's id). An explicit field instead of smuggling it via `meta.id`.
   */
  id?: string
  role: string
  name?: string
  /** Message parts. Mutually exclusive with `text`. */
  parts?: Part[]
  /** Shorthand for a single text-part. */
  text?: string
  /** Explicit parent. Unset → active leaf; `null` → new root. */
  parent?: string | null
  flags?: MessageFlags
  meta?: Record<string, unknown>
}
