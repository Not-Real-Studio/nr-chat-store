/**
 * nr-chat codec — mutations as patches (§6).
 *
 * Same principle as `replaceSpan` in nr-chat: surgery, bytes outside the patch
 * are untouched. Functions return `Patch[]`; the caller applies them
 * (`applyPatches` — a pure helper, no IO). Append writes to the end (append-only
 * is preserved); splice is a targeted span edit.
 *
 * Where a mutation needs tree knowledge (swipe: branch points, descent to a
 * leaf) it projects the session to store nodes (`project`) and runs the core
 * tree math (`../tree.js`), then bridges back to the source `SessionNode` via
 * `bySid` for the actual byte surgery. The tree math is never re-implemented.
 */

import { replaceSpan, stringify } from '@notrealstudio/nr-chat'
import type { ChatMessage, Span } from '@notrealstudio/nr-chat'
import type { Part, SessionModel, StoreNode } from '../model.js'
import type { Session, SessionHeader, SessionNode } from './session.js'
import { META_ROLE } from './session.js'
import { activePath, descendToLeaf, resolveTree, swipeInfo, type Tree } from '../tree.js'
import { project } from './project.js'
import { partToSubMessage } from './parts.js'

/** Patch: append to the end (`append`) or replace a span (`splice`) (§6). */
export type Patch =
  | { kind: 'append'; text: string }
  | { kind: 'splice'; span: Span; replacement: string }

/** A message to append: body/parts + meta. */
export interface MessageInput {
  role: string
  name?: string
  meta?: Record<string, unknown>
  /** Message parts. The first text-part becomes the node body, the rest become `%%` sub-nodes. */
  parts?: Part[]
  /** Shortcut for a single text-part (mutually exclusive with `parts`). */
  body?: string
}

export interface MutateOpts {
  /** Short-id generator (default — a 4-char base36 with a uniqueness check). */
  genId?: () => string
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomId(): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return s
}

/** All ids already taken in the file (nodes + header) — so new ones do not collide. */
function existingIds(session: Session): Set<string> {
  const ids = new Set<string>()
  if (session.header?.id) ids.add(session.header.id)
  for (const node of session.nodes) if (node.id) ids.add(node.id)
  return ids
}

/** Factory for a file-unique id over the provided/default generator. */
function idFactory(session: Session, opts?: MutateOpts): () => string {
  const taken = existingIds(session)
  const gen = opts?.genId ?? randomId
  return () => {
    let id = gen()
    while (taken.has(id)) id = gen()
    taken.add(id)
    return id
  }
}

/**
 * Canonical marker line (`%role name {meta}`) without a body. Goes through the
 * nr-chat `stringify`, i.e. the same name/meta escaping as the rest of the format.
 */
function markerLine(role: string, name: string | undefined, meta: Record<string, unknown> | undefined): string {
  const msg: ChatMessage = { role, body: '' }
  if (name !== undefined) msg.name = name
  if (meta !== undefined) msg.meta = meta
  return stringify([msg]).replace(/\n$/, '')
}

/**
 * Span of just the marker line inside a node's span (the first line). Editing
 * meta does not touch the body bytes — the body survives round-trip verbatim.
 */
function markerSpan(text: string, fullSpan: Span): Span {
  const nl = text.indexOf('\n', fullSpan.start)
  const end = nl === -1 || nl > fullSpan.end ? fullSpan.end : nl
  return { start: fullSpan.start, end }
}

/** Splice patch that rewrites a node's marker with new meta (body untouched). */
function editNodeMeta(session: Session, node: SessionNode, meta: Record<string, unknown>): Patch {
  return {
    kind: 'splice',
    span: markerSpan(session.text, node.message.span),
    replacement: markerLine(node.role, node.name, meta),
  }
}

/** Splice patch that rewrites the `%meta` header marker with new meta. */
function editHeaderMeta(session: Session, header: SessionHeader, meta: Record<string, unknown>): Patch {
  return {
    kind: 'splice',
    span: markerSpan(session.text, header.message.span),
    replacement: markerLine(META_ROLE, header.name, meta),
  }
}

/**
 * Resolve a node reference: an explicit id or a positional handle `pos:N` (as
 * `toProtocol` emits them, §5). Addressing by `pos:N` reaches a node with no
 * explicit id — exactly where a mutation "assigns an id when absent". No tree
 * math needed: an id lookup plus positional access over the ordered nodes.
 */
function resolveRef(session: Session, ref: string): SessionNode | undefined {
  if (ref.startsWith('pos:')) {
    const n = Number(ref.slice(4))
    return Number.isInteger(n) ? session.nodes[n] : undefined
  }
  return session.nodes.find((node) => node.id === ref)
}

/** Build the nr-chat node text (regular node + `%%` sub-nodes) for appending. */
function buildNodeText(input: MessageInput, extraMeta: Record<string, unknown>): string {
  const parts: Part[] = input.parts ?? (input.body !== undefined ? [{ type: 'text', text: input.body }] : [])

  let bodyText = ''
  let rest = parts
  if (parts.length > 0 && parts[0].type === 'text') {
    bodyText = parts[0].text
    rest = parts.slice(1)
  }

  const mergedMeta = { ...(input.meta ?? {}), ...extraMeta }
  const parent: ChatMessage = { role: input.role, body: bodyText }
  if (input.name !== undefined) parent.name = input.name
  if (Object.keys(mergedMeta).length > 0) parent.meta = mergedMeta

  const messages: ChatMessage[] = [parent, ...rest.map(partToSubMessage)]
  return stringify(messages)
}

/**
 * Append a message to the end of the file, continuing the active path (§6).
 * The linear case (no `currNode`, leaf = last node) — zero meta, zero overhead:
 * chain default makes the new node a continuation on its own. If the active leaf
 * is not the last node of the file (we are on a swiped branch), the new node
 * gets an explicit `parent`; with a set `currNode` it is moved to the new leaf.
 */
export function appendMessage(session: Session, msg: MessageInput, _opts?: MutateOpts): Patch[] {
  const patches: Patch[] = []

  const lastNode = session.nodes[session.nodes.length - 1]
  const currNode = session.header?.meta.currNode
  const hasCurr = typeof currNode === 'string'
  const leaf = hasCurr ? resolveRef(session, currNode) ?? lastNode : lastNode

  const extraMeta: Record<string, unknown> = {}

  // An explicit parent is only needed when the append does not continue the last node of the file.
  if (leaf && leaf !== lastNode && leaf.id) {
    extraMeta.parent = leaf.id
  }

  patches.push({ kind: 'append', text: buildNodeText(msg, extraMeta) })

  // The new leaf becomes the last node of the file. If currNode was set, it
  // still points at the old leaf — drop it so the new node becomes active (rule
  // "no currNode → leaf = last node", §2). Cheaper than generating an id.
  if (hasCurr && session.header) {
    const nextMeta = { ...session.header.meta }
    delete nextMeta.currNode
    patches.push(editHeaderMeta(session, session.header, nextMeta))
  }

  return patches
}

/**
 * Branch at `nodeId` (§3, §6): a new child node of the branch point, appended to
 * the end of the file with an explicit `parent`. The branch point is assigned an
 * `id` if it lacks one; `currNode` is left as is (the new node is the last node,
 * hence the default active leaf). Regenerate = a branch from the same parent:
 * call with the message's parent id.
 */
export function branchAt(session: Session, nodeId: string, msg: MessageInput, opts?: MutateOpts): Patch[] {
  const target = resolveRef(session, nodeId)
  if (!target) throw new Error(`nr-chat-store/nr-chat: branchAt — node '${nodeId}' not found`)

  const nextId = idFactory(session, opts)
  const patches: Patch[] = []

  // The branch point must be addressable by id (the new branch references it via
  // an explicit parent). Usually the id is already there; when addressing by
  // pos:N we assign one (this is "the id appears on the target"). The edit is
  // the target's marker line, body untouched.
  let targetId = target.id
  if (!targetId) {
    targetId = nextId()
    patches.push(editNodeMeta(session, target, { ...(target.meta ?? {}), id: targetId }))
  }

  // The new branch is an append to the end with an explicit parent. We do NOT
  // assign an id to the new node (lazy id, §3): it is the last node of the file
  // and thus the default active leaf (§2), so currNode need not move —
  // append-only is preserved.
  patches.push({ kind: 'append', text: buildNodeText(msg, { parent: targetId }) })

  return patches
}

/** Swipe direction for `swipeTo`. */
export type SwipeDir = { dir: 'next' | 'prev' }

/** Deepest branch point on the active path (the last divergence). */
function deepestBranchPoint(model: SessionModel, tree: Tree): StoreNode | undefined {
  const path = activePath(model, tree)
  for (let i = path.length - 1; i >= 0; i--) {
    if (swipeInfo(path[i], tree).count > 1) return path[i]
  }
  return undefined
}

/**
 * Switch the active branch (§6): a patch of the `%meta` span (currNode). The
 * target is a concrete `nodeId` or a direction `{dir}` among the siblings of the
 * active path's deepest branch point. Only the `%meta` marker changes (plus, if
 * needed, the target leaf's id); the rest of the bytes are identical.
 *
 * Tree navigation runs in the core over the projected store nodes; the chosen
 * leaf is bridged back to its source node (`bySid`) for the marker surgery.
 *
 * @throws if there is no header (nowhere to write currNode) or the target does not resolve.
 */
export function swipeTo(session: Session, target: string | SwipeDir, opts?: MutateOpts): Patch[] {
  if (!session.header) {
    throw new Error('nr-chat-store/nr-chat: swipeTo requires a %meta header (nowhere to write currNode)')
  }

  const { nodes, bySid } = project(session)
  const model: SessionModel = { info: { id: '' }, nodes }
  const currNode = session.header.meta.currNode
  if (typeof currNode === 'string' && nodes.some((n) => n.id === currNode)) model.meta = { activeLeaf: currNode }
  const tree = resolveTree(nodes)

  let storeNode: StoreNode | undefined
  if (typeof target === 'string') {
    // An explicit id and `pos:N` are both valid sids — keys of the core byId.
    storeNode = tree.byId.get(target)
    if (!storeNode) throw new Error(`nr-chat-store/nr-chat: swipeTo — node '${target}' not found`)
  } else {
    const branch = deepestBranchPoint(model, tree)
    if (!branch) throw new Error('nr-chat-store/nr-chat: swipeTo — active path has no branch point')
    const info = swipeInfo(branch, tree)
    const delta = target.dir === 'next' ? 1 : -1
    const next = Math.min(info.count - 1, Math.max(0, info.active + delta))
    storeNode = info.siblings[next]
  }

  // Active leaf of the chosen branch — descend to the leaf, then bridge to source.
  const leafStore = descendToLeaf(storeNode, tree)
  const leaf = bySid.get(leafStore.id)!

  const nextId = idFactory(session, opts)
  const patches: Patch[] = []

  let leafId = leaf.id
  if (!leafId) {
    leafId = nextId()
    patches.push(editNodeMeta(session, leaf, { ...(leaf.meta ?? {}), id: leafId }))
  }

  patches.push(editHeaderMeta(session, session.header, { ...session.header.meta, currNode: leafId }))
  return patches
}

/**
 * Apply patches to text (pure, no IO). Splices go right-to-left (by descending
 * offset) so edits do not shift each other's spans; appends go to the end, with
 * a separating newline when needed.
 */
export function applyPatches(text: string, patches: Patch[]): string {
  let out = text

  const splices = patches.filter((p): p is Extract<Patch, { kind: 'splice' }> => p.kind === 'splice')
  splices.sort((a, b) => b.span.start - a.span.start)
  for (const s of splices) out = replaceSpan(out, s.span, s.replacement)

  for (const p of patches) {
    if (p.kind !== 'append') continue
    out = out.length > 0 && !out.endsWith('\n') ? out + '\n' + p.text : out + p.text
  }

  return out
}
