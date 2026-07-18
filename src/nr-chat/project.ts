/**
 * nr-chat driver — projection of the file model onto the neutral store model.
 *
 * The nr-chat file stores the tree lazily (`{id, parent}` in meta, an absent
 * `parent` meaning "chain default"). The driver **unfolds** that convention on
 * load: every node gets an EXPLICIT parent (the store model's common
 * denominator). Folding back — minimal meta where chain default does the work —
 * lives in the write step (`mutate.ts`). Tree math is never re-implemented here:
 * it runs once in the core over `StoreNode` (`../tree.js`).
 */

import type { Session, SessionNode } from './session.js'
import { assembleParts, type PartDecoders } from './parts.js'
import { headerToSessionInfo } from './protocol.js'
import { activePath } from '../tree.js'
import type { MessageFlags, SessionModel, StoreNode } from '../model.js'

/** Stable node id: explicit from meta, else positional `pos:N`. */
export function nodeSid(node: SessionNode): string {
  return node.id ?? `pos:${node.index}`
}

function flagsOf(meta: Record<string, unknown> | undefined): MessageFlags | undefined {
  if (!meta) return undefined
  const flags: MessageFlags = {}
  if (meta.hidden === true) flags.hidden = true
  if (meta.frozen === true) flags.frozen = true
  if (meta.injected === true) flags.injected = true
  return Object.keys(flags).length ? flags : undefined
}

/** Node meta for the model: driver specifics without structural id/parent/flags. */
function metaOf(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const { id: _id, parent: _parent, hidden: _h, frozen: _f, injected: _i, ...rest } = meta
  return Object.keys(rest).length ? rest : undefined
}

/**
 * Unfold the chain default into an explicit parent sid for each node. Explicit
 * `meta.parent` (resolved against known ids) wins; otherwise the parent is the
 * previous regular node (chain default); the first node is a root. A dangling
 * explicit reference degrades to a root — the core treats it the same way.
 */
function parentSids(session: Session): Map<string, string | null> {
  const byId = new Map<string, SessionNode>()
  for (const node of session.nodes) if (node.id !== undefined) byId.set(node.id, node)

  const out = new Map<string, string | null>()
  for (let i = 0; i < session.nodes.length; i++) {
    const node = session.nodes[i]
    let parent: SessionNode | null = null
    // Three-state (§2): `null` = explicit root (stays null, no chain default); a
    // string = explicit parent (dangling ref degrades to root); `undefined` =
    // chain default (the previous node), the first node being a root.
    if (node.parent === null) parent = null
    else if (node.parent !== undefined) parent = byId.get(node.parent) ?? null
    else if (i > 0) parent = session.nodes[i - 1]
    out.set(nodeSid(node), parent ? nodeSid(parent) : null)
  }
  return out
}

/**
 * Result of projecting a parsed session: the store nodes plus a `bySid` bridge
 * back to the source `SessionNode` (its span), kept for mutation surgery — that
 * is a codec concern, not a tree one.
 */
export interface Projection {
  nodes: StoreNode[]
  /** sid → source SessionNode, for byte-surgery over spans. */
  bySid: Map<string, SessionNode>
}

/**
 * Session → store nodes with explicit parent (unfolded early). Same node order
 * as the file (append order of the store model).
 */
export function project(session: Session, decoders?: PartDecoders): Projection {
  const parents = parentSids(session)
  const bySid = new Map<string, SessionNode>()

  const nodes: StoreNode[] = session.nodes.map((node) => {
    const sid = nodeSid(node)
    bySid.set(sid, node)
    const out: StoreNode = {
      id: sid,
      parent: parents.get(sid) ?? null,
      role: node.role,
      parts: assembleParts(node, decoders),
    }
    if (node.name !== undefined) out.name = node.name
    const flags = flagsOf(node.meta)
    if (flags) out.flags = flags
    const meta = metaOf(node.meta)
    if (meta) out.meta = meta
    return out
  })

  return { nodes, bySid }
}

/**
 * Session → SessionModel: the whole tree, parent unfolded (§3). `activeLeaf`
 * from the header's `currNode` when it resolves; `info` from `%meta`.
 */
export function toModel(session: Session, decoders?: PartDecoders): SessionModel {
  const { nodes } = project(session, decoders)

  const model: SessionModel = { info: { id: '' }, nodes }

  const currNode = session.header?.meta.currNode
  if (typeof currNode === 'string' && nodes.some((n) => n.id === currNode)) {
    model.meta = { activeLeaf: currNode }
  }

  // Active-path length (history) is core math over the unfolded tree.
  model.info = headerToSessionInfo(session.header, activePath(model).length)
  return model
}
