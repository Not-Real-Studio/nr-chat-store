/**
 * nr-chat codec — the session model over the nr-chat format (§2–4).
 *
 * `parseSession` reads an nr-chat stream (via @notrealstudio/nr-chat) and layers
 * session conventions on top of the format without changing it: the `%meta`
 * header (§2), the `{id, parent}` tree in meta (§3), `%%` sub-nodes as message
 * parts (§4). The nr-chat grammar is not reinterpreted — parse/stringify/
 * replaceSpan work as-is; this is only a layer of meaning.
 *
 * Format reference: the package README (nr-chat format / model / contract).
 */

import { parse } from '@notrealstudio/nr-chat'
import type { ChatMessageWithSpan, Span } from '@notrealstudio/nr-chat'

/** Role of the `%meta` header (§2). Reserved by the nr-chat spec §2.3. */
export const META_ROLE = 'meta'

/**
 * A `%%` sub-node (§4): a role in the stream that starts with `%` (the marker
 * `%%xxx` → role `%xxx` per the nr-chat grammar). It is a part of the nearest
 * regular node above, exactly one level deep. It takes no part in the tree and
 * carries no id/parent.
 */
export interface SubNode {
  /** Role as nr-chat sees it: `%thinking`, `%tool_use`, … (with a leading `%`). */
  rawRole: string
  /** Core dictionary key: `thinking`, `tool_use`, … (without the leading `%`). */
  kind: string
  name?: string
  meta?: Record<string, unknown>
  body: string
  message: ChatMessageWithSpan
}

/**
 * A regular session node (§3): a dialogue-tree node with attached sub-nodes.
 * `id`/`parent` are lazy (§3): present only where they are needed.
 */
export interface SessionNode {
  /** Position among the file's regular nodes (0-based). Basis of the `pos:N` id (§5). */
  index: number
  role: string
  name?: string
  meta?: Record<string, unknown>
  /** Body of the regular node = the first text-part (everything up to the first sub-node, §4). */
  body: string
  /** Explicit id from meta (§3). Absent on nodes nothing references. */
  id?: string
  /**
   * Explicit parent from meta (§3) — three states (§2): absent (`undefined`) →
   * chain default (the previous node); `null` → an explicit root (serialized as
   * `{parent: null}`, read via hasOwn); a string → an explicit parent id.
   */
  parent?: string | null
  subNodes: SubNode[]
  /** Span of the regular node itself (marker + body), without sub-nodes. */
  message: ChatMessageWithSpan
  /** Span of the whole group: the regular node + its sub-nodes. */
  span: Span
}

/** The `%meta` session header (§2). Not sent to the LLM; the body is a free zone. */
export interface SessionHeader {
  /** Required session id (§2), when set. */
  id?: string
  name?: string
  /** Parsed header meta (an open dictionary, round-trip preserved). */
  meta: Record<string, unknown>
  body: string
  /** `%%` sub-nodes of the header (§2): structural session state → sessionMeta. */
  subNodes: SubNode[]
  message: ChatMessageWithSpan
  span: Span
}

/**
 * A parsed session: the header (if any) + regular nodes with their sub-nodes.
 * `text` is the source bytes, the basis for span surgery (§6).
 */
export interface Session {
  text: string
  header?: SessionHeader
  nodes: SessionNode[]
}

/** Sub-node role: a `%%…` marker, i.e. a role with a leading `%` (§4). */
function isSubRole(role: string): boolean {
  return role.startsWith('%')
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Read the three-state `parent` from a node's meta (§2): a missing key →
 * `undefined` (chain default); `parent: null` → `null` (explicit root); a string
 * → the parent id. Any other value degrades to `undefined` (chain default).
 */
function readParent(meta: Record<string, unknown> | undefined): string | null | undefined {
  if (!meta || !Object.prototype.hasOwnProperty.call(meta, 'parent')) return undefined
  const p = meta.parent
  if (p === null) return null
  return typeof p === 'string' ? p : undefined
}

/**
 * Parse an nr-chat stream into a session. Conventions are layered on top of
 * nr-chat: the first node with role `meta` is the header; roles starting with
 * `%` are sub-nodes of the nearest regular node above; the rest are regular
 * tree nodes.
 *
 * A file with no `%meta` is a legal stream but not a session: `header` is
 * `undefined`, tree functions still work, the session projection yields a
 * minimal SessionInfo (§2).
 *
 * @throws {SyntaxError} propagated from nr-chat on invalid JSON5 meta.
 */
export function parseSession(text: string): Session {
  const messages = parse(text, { spans: true })
  const nodes: SessionNode[] = []
  let header: SessionHeader | undefined
  let current: SessionNode | undefined

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    // Header: role `meta` as the first node of the file. A later `meta` in the
    // stream is a checkpoint (§8.1, v2): treated as a regular node, the core does
    // not block it.
    if (msg.role === META_ROLE && header === undefined && nodes.length === 0 && current === undefined) {
      header = {
        id: asString(msg.meta?.id),
        name: msg.name,
        meta: msg.meta ?? {},
        body: msg.body,
        subNodes: [],
        message: msg,
        span: msg.span,
      }
      continue
    }

    if (isSubRole(msg.role)) {
      // A sub-node attaches to the nearest regular node above; before the first
      // regular node the carrier is the `%meta` header (§2: structural state →
      // sessionMeta). An orphan with no header has no carrier — ignored.
      if (!current && !header) continue
      const sub: SubNode = {
        rawRole: msg.role,
        kind: msg.role.slice(1),
        name: msg.name,
        meta: msg.meta,
        body: msg.body,
        message: msg,
      }
      if (current) {
        current.subNodes.push(sub)
        current.span = { start: current.span.start, end: msg.span.end }
      } else if (header) {
        header.subNodes.push(sub)
        header.span = { start: header.span.start, end: msg.span.end }
      }
      continue
    }

    // A regular node — a new tree node.
    current = {
      index: nodes.length,
      role: msg.role,
      name: msg.name,
      meta: msg.meta,
      body: msg.body,
      id: asString(msg.meta?.id),
      parent: readParent(msg.meta),
      subNodes: [],
      message: msg,
      span: { start: msg.span.start, end: msg.span.end },
    }
    nodes.push(current)
  }

  return { text, header, nodes }
}
