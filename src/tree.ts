/**
 * @notrealstudio/nr-chat-store — tree math over the neutral model (spec §4).
 *
 * The tree doesn't belong to any one driver: the nr-chat codec, the pi codec and
 * claude transcripts were each implementing the same math — here it lives once,
 * generalized over `StoreNode` (parent always explicit). Pure, zero-dep.
 *
 * Two projections of one tree:
 *   - `toHistory` — active path + swipes; branches = alternatives (dialogue);
 *   - `toThread`  — full traversal (DFS, depth per node); all branches live (threads).
 */

import type { Message, MessageFlags, MessageMeta, Part, SessionModel, StoreNode, Usage } from './model.js'

/** Resolved tree: parent/children indices over the nodes. */
export interface Tree {
  /** Roots in order of appearance (normally one). */
  roots: StoreNode[]
  parentOf: Map<StoreNode, StoreNode | null>
  childrenOf: Map<StoreNode, StoreNode[]>
  byId: Map<string, StoreNode>
}

/** A node's position among its siblings — the basis for swipes. */
export interface SwipeInfo {
  /** The node's index among its siblings. */
  active: number
  /** Number of siblings (branches at this point). */
  count: number
  siblings: StoreNode[]
}

/**
 * Build the tree index. `parent` is explicit: resolved via `byId`. A ref to a
 * non-existent id → the node is treated as a root (a broken ref doesn't fail
 * the resolve, §4). Children order = node append-order.
 */
export function resolveTree(nodes: StoreNode[]): Tree {
  const byId = new Map<string, StoreNode>()
  for (const node of nodes) {
    // Duplicate ids shouldn't reach here (drivers reject them on append, §2), but
    // a hand-edited/foreign file might carry them. Stay tolerant — last wins for
    // lookups — and warn so the corruption is diagnosable rather than silent.
    if (byId.has(node.id)) console.warn(`nr-chat-store: duplicate node id ${JSON.stringify(node.id)} — tree lookups will use the last occurrence`)
    byId.set(node.id, node)
  }

  const parentOf = new Map<StoreNode, StoreNode | null>()
  const childrenOf = new Map<StoreNode, StoreNode[]>()
  const roots: StoreNode[] = []
  for (const node of nodes) childrenOf.set(node, [])

  for (const node of nodes) {
    // `parent === node.id` (self-parent) is cut to a root, same as a dangling ref.
    const parent = node.parent != null && node.parent !== node.id ? byId.get(node.parent) ?? null : null
    parentOf.set(node, parent)
    if (parent) childrenOf.get(parent)!.push(node)
    else roots.push(node)
  }

  return { roots, parentOf, childrenOf, byId }
}

/**
 * Active leaf: `meta.activeLeaf` from the model if it resolves to an existing
 * node, otherwise the last storage node (§4). The convention "no activeLeaf →
 * leaf = last node" is shared across drivers (mds currNode, pi "last line").
 */
export function activeLeaf(model: SessionModel, tree = resolveTree(model.nodes)): StoreNode | undefined {
  const hint = model.meta?.activeLeaf
  if (typeof hint === 'string') {
    const node = tree.byId.get(hint)
    if (node) return node
  }
  return model.nodes[model.nodes.length - 1]
}

/**
 * Active path: from root to active leaf along parent refs. This is the
 * protocol's `history()` for any driver, for free. Order is chronological (root
 * first). Cycles are cut off.
 */
export function activePath(model: SessionModel, tree = resolveTree(model.nodes)): StoreNode[] {
  const leaf = activeLeaf(model, tree)
  const path: StoreNode[] = []
  let cur: StoreNode | null | undefined = leaf
  const seen = new Set<StoreNode>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    path.push(cur)
    cur = tree.parentOf.get(cur) ?? null
  }
  return path.reverse()
}

/** A node's siblings = the shared children of its parent (or the roots, if no parent). */
export function siblingsOf(node: StoreNode, tree: Tree): StoreNode[] {
  const parent = tree.parentOf.get(node) ?? null
  return parent ? tree.childrenOf.get(parent)! : tree.roots
}

/**
 * A node's swipe-info: siblings, its index among them (`active`), the count
 * (`count`). `count > 1` is a branch point, where the UI shows swipes.
 */
export function swipeInfo(node: StoreNode, tree: Tree): SwipeInfo {
  const siblings = siblingsOf(node, tree)
  return { active: siblings.indexOf(node), count: siblings.length, siblings }
}

/** Descend from a node to a leaf, following the last child (the freshest branch). */
export function descendToLeaf(node: StoreNode, tree: Tree): StoreNode {
  let cur = node
  const seen = new Set<StoreNode>()
  for (;;) {
    if (seen.has(cur)) return cur
    seen.add(cur)
    const children = tree.childrenOf.get(cur)!
    if (children.length === 0) return cur
    cur = children[children.length - 1]
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Projections (§4)
// ────────────────────────────────────────────────────────────────────────────

function bool(v: unknown): boolean | undefined {
  return v === true ? true : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Message flags from the node meta — known keys as-is. */
function flagsOf(meta: Record<string, unknown> | undefined, own: MessageFlags | undefined): MessageFlags | undefined {
  const flags: MessageFlags = { ...(own ?? {}) }
  if (meta) {
    if (bool(meta.hidden)) flags.hidden = true
    if (bool(meta.frozen)) flags.frozen = true
    if (bool(meta.injected)) flags.injected = true
  }
  return Object.keys(flags).length ? flags : undefined
}

/** `model`/`usage`/`createdAt` from the node meta → `Message.meta`. */
function metaOf(meta: Record<string, unknown> | undefined): MessageMeta | undefined {
  if (!meta) return undefined
  const out: MessageMeta = {}
  const createdAt = str(meta.createdAt)
  const model = str(meta.model)
  if (createdAt !== undefined) out.createdAt = createdAt
  if (model !== undefined) out.model = model
  if (meta.usage && typeof meta.usage === 'object') out.usage = meta.usage as Usage
  return Object.keys(out).length ? out : undefined
}

/**
 * Node → `Message`. `swipes` is attached only where there's more than one
 * branch; `hash` is content-based (role + parts), for optimistic concurrency on
 * edit.
 */
export function nodeToMessage(node: StoreNode, tree: Tree): Message {
  const message: Message = { id: node.id, role: node.role, parts: node.parts }
  if (node.name !== undefined) message.name = node.name

  const flags = flagsOf(node.meta, node.flags)
  if (flags) message.flags = flags

  const meta = metaOf(node.meta)
  if (meta) message.meta = meta

  const info = swipeInfo(node, tree)
  if (info.count > 1) message.swipes = { active: info.active, count: info.count }

  message.hash = contentHash(node.role, node.parts)
  return message
}

/**
 * The protocol's `history()`: active path → `Message[]`, branches =
 * alternatives. Order is root to leaf.
 */
export function toHistory(model: SessionModel, tree = resolveTree(model.nodes)): Message[] {
  return activePath(model, tree).map((node) => nodeToMessage(node, tree))
}

/** A thread node: the message + its depth in the tree (root = 0). */
export interface ThreadNode {
  message: Message
  depth: number
}

/**
 * Full tree traversal (DFS, prefix), branches = neighbors (all live) — the
 * projection for threads (reddit/discord/comments). Children order is
 * append-order. Protocol v1 doesn't render threads; that's legal — it's one
 * client of the model out of N (§4).
 */
export function toThread(model: SessionModel, tree = resolveTree(model.nodes)): ThreadNode[] {
  const out: ThreadNode[] = []
  const seen = new Set<StoreNode>()
  const walk = (node: StoreNode, depth: number): void => {
    if (seen.has(node)) return
    seen.add(node)
    out.push({ message: nodeToMessage(node, tree), depth })
    for (const child of tree.childrenOf.get(node)!) walk(child, depth + 1)
  }
  for (const root of tree.roots) walk(root, 0)
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Content hash (optimistic concurrency)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Hash of the message body: role + parts. Computed over the body, not the whole
 * node — `ifHash` guards against editing over someone else's edit, not against
 * a parent/time change: a swipe/branch move doesn't move the hash, a text edit
 * does.
 *
 * FNV-1a 32-bit (zero-dep, deterministic, cross-platform): collisions aren't
 * critical here — this is change detection, not a crypto signature.
 */
export function contentHash(role: string, parts: Part[]): string {
  const canonical = JSON.stringify({ role, parts })
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
