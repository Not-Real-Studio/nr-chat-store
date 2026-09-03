/**
 * nr-chat driver (`./nr-chat`) — the full set of capabilities (§7.1).
 *
 * The nr-chat codec (parse/patches/partToSubMessage/projection) lives alongside
 * — files `session/parts/mutate/protocol/project`; the driver is the contract
 * wrapper over it. Span surgery: bytes outside the operation's span are not
 * rewritten (§5). `decoders` is a driver option (toon is not a dependency).
 * Sidecar assets — `{id}.assets/`.
 *
 * Storage is a directory of `.mds` files, one per session (`{id}.mds`). The
 * on-disk file extension is not the driver name: `.mds` files persist, `nr-chat`
 * is the format the driver speaks.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { stringify } from '@notrealstudio/nr-chat'
import type { ChatMessage, Span } from '@notrealstudio/nr-chat'
import { META_ROLE, parseSession, type Session, type SessionNode } from './session.js'
import { assembleParts, decodeSubBody, partToSubMessage, type PartDecoders } from './parts.js'
import { appendMessage, applyPatches, branchAt, type Patch } from './mutate.js'
import type { MessageFlags, NodeInput, Part, SessionInfo, SessionModel, StoreNode } from '../model.js'
import {
  StoreConflictError,
  StoreNodeNotFound,
  StoreSessionNotFound,
  assertSafeAssetName,
  assertSafeId,
  paginate,
  partsOf,
  replaceTextParts,
  type NodePatch,
  type SessionStore,
  type StoreCapabilities,
} from '../store.js'
import { activeLeaf, contentHash, resolveTree, type Tree } from '../tree.js'
import { nodeSid, project, toModel } from './project.js'

export interface NrChatStoreOpts {
  /** Directory of session `.mds` files (multi-session mode). */
  dir?: string
  /**
   * Single-file mode: one session backed by exactly this file (any extension).
   * `dir` defaults to the file's directory. `fork` is unavailable (no
   * multi-session home) — every other capability operates on the one file. For
   * single-doc consumers (chat3/rpbot) whose session is an arbitrary `.md`/`.mds`
   * file at a path, not a folder of `{id}.mds`. `sessionId` is a label; all
   * operations hit this file regardless of the id passed.
   */
  file?: string
  /** Injected body decoders keyed by `format` (toon and the like). */
  decoders?: PartDecoders
}

const CAPABILITIES: StoreCapabilities = {
  edits: { edit: true, delete: true, hide: true },
  swipes: true,
  fork: true,
  rename: true,
  assets: true,
  sessionMeta: true,
}

/** Single-file mode caps: everything except fork (no multi-session home). */
const SINGLE_CAPABILITIES: StoreCapabilities = {
  edits: { edit: true, delete: true, hide: true },
  swipes: true,
  fork: false,
  rename: true,
  assets: true,
  sessionMeta: true,
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** nr-chat driver factory (§6/§7.1). */
export function createNrChatStore(opts: NrChatStoreOpts): SessionStore {
  const { decoders } = opts
  const single = opts.file
  const resolvedDir = opts.dir ?? (single ? dirname(single) : undefined)
  if (resolvedDir === undefined) {
    throw new Error('nr-chat-store/nr-chat: createNrChatStore needs `dir` or `file`')
  }
  const dir = resolvedDir

  // Single-file mode: any session id maps to the one file (no path-building, so
  // an arbitrary id/extension is fine). Multi-session mode: `{dir}/{id}.mds`.
  function pathOf(id: string): string {
    return single ?? join(dir, `${assertSafeId(id, 'session id')}.mds`)
  }

  function read(id: string): { text: string; session: Session } {
    const path = pathOf(id)
    if (!existsSync(path)) throw new StoreSessionNotFound(id)
    const text = readFileSync(path, 'utf-8')
    return { text, session: parseSession(text) }
  }

  function write(id: string, text: string): void {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(pathOf(id), text, 'utf-8')
  }

  /** A short id unique within the file (4 base36) — for assigning lazy ids. */
  function idFactory(session: Session): () => string {
    const taken = new Set<string>()
    if (session.header?.id) taken.add(session.header.id)
    for (const n of session.nodes) if (n.id) taken.add(n.id)
    return () => {
      for (;;) {
        let s = ''
        const rnd = randomUUID().replace(/-/g, '')
        for (let i = 0; i < 4; i++) s += ID_ALPHABET[parseInt(rnd.slice(i * 2, i * 2 + 2), 16) % 36]
        if (!taken.has(s)) {
          taken.add(s)
          return s
        }
      }
    }
  }

  /**
   * Project + core tree for structural ops (delete/fork), carrying the
   * sid → SessionNode bridge for byte surgery over spans.
   */
  function projectTree(session: Session): { bySid: Map<string, SessionNode>; model: SessionModel; tree: Tree } {
    const { nodes, bySid } = project(session, decoders)
    const model: SessionModel = { info: { id: '' }, nodes }
    const currNode = session.header?.meta.currNode
    if (typeof currNode === 'string' && nodes.some((n) => n.id === currNode)) model.meta = { activeLeaf: currNode }
    return { bySid, model, tree: resolveTree(nodes) }
  }

  /** Node reference: an explicit id or a positional `pos:N`. */
  function resolveNode(session: Session, ref: string): SessionNode | undefined {
    if (ref.startsWith('pos:')) {
      const n = Number(ref.slice(4))
      return Number.isInteger(n) ? session.nodes[n] : undefined
    }
    return session.nodes.find((node) => node.id === ref)
  }

  function requireNode(session: Session, ref: string): SessionNode {
    const node = resolveNode(session, ref)
    if (!node) throw new StoreNodeNotFound(ref)
    return node
  }

  function activeLeafSid(session: Session): string | undefined {
    return activeLeaf(projectTree(session).model)?.id
  }

  /** Meta for writing: fold flags into the meta dictionary. `hidden` is legacy — not produced. */
  function withFlags(meta: Record<string, unknown> | undefined, flags: MessageFlags | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(meta ?? {}) }
    if (flags?.visible === false) out.visible = false
    if (flags?.disabled || flags?.hidden) out.disabled = true
    if (flags?.frozen) out.frozen = true
    if (flags?.injected) out.injected = true
    return out
  }

  // ── node serialization ─────────────────────────────────────────────────────

  /** Parts + meta → nr-chat node text (regular node + `%%` sub-nodes), no trailing `\n`. */
  function nodeText(role: string, name: string | undefined, meta: Record<string, unknown>, parts: Part[]): string {
    let bodyText = ''
    let rest = parts
    if (parts.length > 0 && parts[0].type === 'text') {
      bodyText = parts[0].text
      rest = parts.slice(1)
    }
    const parent: ChatMessage = { role, body: bodyText }
    if (name !== undefined) parent.name = name
    if (Object.keys(meta).length > 0) parent.meta = meta
    const messages: ChatMessage[] = [parent, ...rest.map(partToSubMessage)]
    return stringify(messages).replace(/\n$/, '')
  }

  /** Marker line only (first line of a node's span): a meta edit, body untouched. */
  function markerText(role: string, name: string | undefined, meta: Record<string, unknown>): string {
    const msg: ChatMessage = { role, body: '' }
    if (name !== undefined) msg.name = name
    if (Object.keys(meta).length > 0) msg.meta = meta
    return stringify([msg]).replace(/\n$/, '')
  }

  function markerSpan(text: string, fullSpan: Span): Span {
    const nl = text.indexOf('\n', fullSpan.start)
    const end = nl === -1 || nl > fullSpan.end ? fullSpan.end : nl
    return { start: fullSpan.start, end }
  }

  /** Span of a group node including its trailing `\n` (for a full delete). */
  function groupSpanWithNewline(text: string, node: SessionNode): Span {
    let end = node.span.end
    if (text[end] === '\n') end += 1
    else if (node.span.start > 0 && text[node.span.start - 1] === '\n') {
      // trailing node: eat the leading newline
      return { start: node.span.start - 1, end: node.span.end }
    }
    return { start: node.span.start, end }
  }

  /** Projection of the same node that `ref` pointed to (position stable across edit). */
  function returnNode(id: string, ref: string): StoreNode {
    const { session } = read(id)
    const node = requireNode(session, ref)
    const sid = nodeSid(node)
    const model = toModel(session, decoders)
    const out = model.nodes.find((n) => n.id === sid)
    if (!out) throw new StoreNodeNotFound(ref)
    return out
  }

  function lastNode(id: string): StoreNode {
    const model = toModel(read(id).session, decoders)
    const node = model.nodes[model.nodes.length - 1]
    if (!node) throw new StoreNodeNotFound('<last>')
    return node
  }

  // ── contract ─────────────────────────────────────────────────────────────

  const store: SessionStore = {
    async capabilities(): Promise<StoreCapabilities> {
      return single ? SINGLE_CAPABILITIES : CAPABILITIES
    },

    async list(opts): Promise<{ sessions: SessionInfo[]; cursor?: string }> {
      const sessions: SessionInfo[] = []
      if (single) {
        if (!existsSync(single)) return { sessions }
        try {
          const model = toModel(parseSession(readFileSync(single, 'utf-8')), decoders)
          const info = { ...model.info, id: model.info.id || basename(single).replace(/\.[^.]+$/, '') }
          try {
            info.updatedAt = new Date(statSync(single).mtimeMs).toISOString()
          } catch {
            /* file went away */
          }
          sessions.push(info)
        } catch {
          /* broken file — skip */
        }
        return { sessions }
      }
      if (!existsSync(dir)) return { sessions }
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.mds')) continue
        const id = name.slice(0, -4)
        try {
          const model = toModel(parseSession(readFileSync(join(dir, name), 'utf-8')), decoders)
          const info = { ...model.info, id }
          try {
            info.updatedAt = new Date(statSync(join(dir, name)).mtimeMs).toISOString()
          } catch {
            /* file went away — don't drop the listing */
          }
          sessions.push(info)
        } catch {
          /* broken file — warn+skip (§8) */
        }
      }
      sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      const page = paginate(sessions, opts)
      return page.cursor !== undefined ? { sessions: page.items, cursor: page.cursor } : { sessions: page.items }
    },

    async load(id: string): Promise<SessionModel> {
      const { session } = read(id)
      const model = toModel(session, decoders)
      model.info.id = id
      return model
    },

    async create(createOpts): Promise<SessionInfo> {
      const id = createOpts?.id ?? randomUUID()
      if (existsSync(pathOf(id))) throw new Error(`nr-chat-store/nr-chat: session ${id} already exists`)
      const meta: Record<string, unknown> = { id }
      const info = createOpts?.info
      if (info?.title) meta.title = info.title
      // Catalog presentation is persisted on create (otherwise botId is lost).
      if (info?.botId) meta.botId = info.botId
      if (info?.botName) meta.botName = info.botName
      if (info?.botAvatar) meta.botAvatar = info.botAvatar
      if (info?.accentColor) meta.accentColor = info.accentColor
      meta.createdAt = info?.createdAt ?? new Date().toISOString()
      write(id, markerText(META_ROLE, undefined, meta) + '\n')
      return { id, title: info?.title, botId: info?.botId, createdAt: meta.createdAt as string, messageCount: 0 }
    },

    async rename(id: string, title: string): Promise<void> {
      // Title change — surgery on the `%meta` header marker (body/sub-nodes intact).
      // No header — synthesize a `%meta {id, title}` at the start of the file.
      const { text, session } = read(id)
      if (!session.header) {
        const header = markerText(META_ROLE, undefined, { id, title })
        write(id, `${header}\n${text}`)
        return
      }
      const nextMeta = { ...session.header.meta, title }
      const splice: Patch = {
        kind: 'splice',
        span: markerSpan(text, session.header.message.span),
        replacement: markerText(META_ROLE, session.header.name, nextMeta),
      }
      write(id, applyPatches(text, [splice]))
    },

    async delete(id: string): Promise<void> {
      const path = pathOf(id)
      if (!existsSync(path)) throw new StoreSessionNotFound(id)
      unlinkSync(path)
      // The sidecar dies with the session (§5): remove `{id}.assets/` after the
      // successful unlink, so a delete leaves no orphaned attachments behind.
      const assetsDir = join(dir, `${id}.assets`)
      if (existsSync(assetsDir)) rmSync(assetsDir, { recursive: true, force: true })
    },

    async appendNode(sid: string, node: NodeInput): Promise<StoreNode> {
      const { text, session } = read(sid)
      // Explicit id for the new node (eager): the id is stable for the contract
      // (§3), independent of position — it survives later branch/delete of
      // siblings. id-first (§5): `node.id` (the explicit contract field) is
      // honored as the record id; otherwise generate.
      const meta = withFlags(node.meta, node.flags)
      if (node.id !== undefined) meta.id = assertSafeId(node.id, 'node id')
      if (meta.id === undefined) meta.id = idFactory(session)()
      // Duplicate id (§2): appending with an id already in the file is rejected —
      // the tree math would silently collapse the two into one node.
      if (session.nodes.some((n) => n.id === meta.id) || session.header?.id === meta.id) {
        throw new Error(`nr-chat-store/nr-chat: node id ${JSON.stringify(meta.id)} already exists in session ${sid}`)
      }
      const parent = node.parent
      // Explicit root (§2): `parent: null` serializes `{parent: null}` so the read
      // sees a root, not a chain-default continuation of the previous line.
      if (parent === null) meta.parent = null
      const input = { role: node.role, name: node.name, meta, parts: partsOf(node) }
      let patches: Patch[]
      if (parent === undefined || parent === null || parent === activeLeafSid(session)) {
        patches = appendMessage(session, input)
      } else {
        patches = branchAt(session, parent, input)
      }
      write(sid, applyPatches(text, patches))
      return lastNode(sid)
    },

    async editNode(sid: string, nid: string, patch: NodePatch): Promise<StoreNode> {
      const { text, session } = read(sid)
      const node = requireNode(session, nid)

      const current = assembleParts(node, decoders)
      if (patch.ifHash !== undefined && contentHash(node.role, current) !== patch.ifHash) {
        throw new StoreConflictError(nid)
      }
      const parts = patch.parts ?? (patch.text !== undefined ? replaceTextParts(current, patch.text) : undefined)
      if (!parts) throw new Error('nr-chat-store/nr-chat: editNode — parts or text required')

      const splice: Patch = { kind: 'splice', span: node.span, replacement: nodeText(node.role, node.name, node.meta ?? {}, parts) }
      write(sid, applyPatches(text, [splice]))
      return returnNode(sid, nid)
    },

    async deleteNode(sid: string, nid: string): Promise<void> {
      const { text, session } = read(sid)
      const target = requireNode(session, nid)
      const { bySid, tree } = projectTree(session)
      const targetStore = tree.byId.get(nodeSid(target))!
      const parentStore = tree.parentOf.get(targetStore) ?? null
      const parentSession = parentStore ? bySid.get(parentStore.id) ?? null : null
      const genId = idFactory(session)

      const patches: Patch[] = []
      let parentId = parentSession?.id ?? null
      if (parentSession && !parentId) {
        parentId = genId()
        patches.push(markerPatch(text, parentSession, { ...(parentSession.meta ?? {}), id: parentId }))
      }

      // Children are reattached to the deleted node's parent (§5): explicit parent
      // in the marker. When the deleted node was a root (parentId null), children
      // become EXPLICIT roots (`parent: null`, §2) — not chain-default, which would
      // glue the first orphan to the previous line in the file.
      for (const childStore of tree.childrenOf.get(targetStore) ?? []) {
        const child = bySid.get(childStore.id)!
        const meta = { ...(child.meta ?? {}) }
        meta.parent = parentId
        patches.push(markerPatch(text, child, meta))
      }

      // currNode on the deleted node — move it to the parent (or drop it).
      if (session.header && session.header.meta.currNode === target.id) {
        const nextMeta = { ...session.header.meta }
        if (parentId === null) delete nextMeta.currNode
        else nextMeta.currNode = parentId
        patches.push({
          kind: 'splice',
          span: markerSpan(text, session.header.message.span),
          replacement: markerText(META_ROLE, session.header.name, nextMeta),
        })
      }

      patches.push({ kind: 'splice', span: groupSpanWithNewline(text, target), replacement: '' })
      write(sid, applyPatches(text, patches))
    },

    async hideNode(sid: string, nid: string, hidden: boolean): Promise<void> {
      const { text, session } = read(sid)
      const node = requireNode(session, nid)
      const meta = { ...(node.meta ?? {}) }
      // hideNode = user toggle "exclude from prompt" → disabled (legacy `hidden` key retired).
      if (hidden) meta.disabled = true
      else {
        delete meta.disabled
        delete meta.hidden
      }
      write(sid, applyPatches(text, [markerPatch(text, node, meta)]))
    },

    async setActiveLeaf(sid: string, nid: string): Promise<void> {
      const { text, session } = read(sid)
      const node = requireNode(session, nid)
      const genId = idFactory(session)
      const patches: Patch[] = []

      let leafId = node.id
      if (!leafId) {
        leafId = genId()
        patches.push(markerPatch(text, node, { ...(node.meta ?? {}), id: leafId }))
      }

      if (session.header) {
        patches.push({
          kind: 'splice',
          span: markerSpan(text, session.header.message.span),
          replacement: markerText(META_ROLE, session.header.name, { ...session.header.meta, currNode: leafId }),
        })
        write(sid, applyPatches(text, patches))
      } else {
        // No header — synthesize a `%meta {currNode}` at the start of the file.
        const header = markerText(META_ROLE, undefined, { id: sid, currNode: leafId })
        const withNode = applyPatches(text, patches)
        write(sid, `${header}\n${withNode}`)
      }
    },

    async forkCopy(sid: string, atNodeId?: string): Promise<SessionInfo> {
      const { session } = read(sid)
      const { bySid, model, tree } = projectTree(session)
      let leafStore: StoreNode | undefined
      if (atNodeId) {
        const node = requireNode(session, atNodeId)
        leafStore = tree.byId.get(nodeSid(node))
      } else {
        leafStore = activeLeaf(model)
      }
      if (!leafStore) throw new Error(`nr-chat-store/nr-chat: session ${sid} is empty — nothing to fork`)

      // Path root→leaf: a linear rewrite without id/parent (chain default).
      const path: SessionNode[] = []
      for (let n: StoreNode | null | undefined = leafStore; n; n = tree.parentOf.get(n) ?? null) {
        path.unshift(bySid.get(n.id)!)
      }

      const newId = randomUUID()
      const createdAt = new Date().toISOString()
      const headerMeta: Record<string, unknown> = { id: newId, createdAt, parentSessionId: sid }
      if (atNodeId) headerMeta.forkMessageId = atNodeId
      if (session.header?.meta.title) headerMeta.title = session.header.meta.title

      // Fork sidecar assets — a private copy of the `{newId}.assets` directory, so
      // deleting/editing the source session doesn't pull files out from under the
      // fork. Refs in parts are rewritten to the new sidecar
      // (`file:{sid}.assets/…` → `{newId}…`).
      const srcAssets = join(dir, `${sid}.assets`)
      if (existsSync(srcAssets)) cpSync(srcAssets, join(dir, `${newId}.assets`), { recursive: true })

      const lines = [markerText(META_ROLE, undefined, headerMeta)]
      for (const node of path) {
        const meta = { ...(node.meta ?? {}) }
        delete meta.id
        delete meta.parent
        const parts = rewriteAssetRefs(assembleParts(node, decoders), sid, newId)
        lines.push(nodeText(node.role, node.name, meta, parts))
      }
      write(newId, lines.join('\n') + '\n')

      return {
        id: newId,
        createdAt,
        parentSessionId: sid,
        forkMessageId: atNodeId,
        title: session.header?.meta.title as string | undefined,
        messageCount: path.length,
      }
    },

    meta: {
      async get(sid: string): Promise<Record<string, unknown>> {
        const { session } = read(sid)
        const out: Record<string, unknown> = {}
        // A sub-node body is decoded by its `format` via the injected decoders
        // (§4): `%%state {format:'json5'}` → an object, not a raw string.
        for (const sub of session.header?.subNodes ?? []) out[sub.kind] = decodeSubBody(sub, decoders)
        const stored = session.header?.meta.sessionMeta
        if (stored && typeof stored === 'object') Object.assign(out, stored)
        return out
      },
      async patch(sid: string, p: Record<string, unknown>): Promise<void> {
        const { text, session } = read(sid)
        if (!session.header) {
          const header = markerText(META_ROLE, undefined, { id: sid, sessionMeta: p })
          write(sid, `${header}\n${text}`)
          return
        }
        const prev = (session.header.meta.sessionMeta as Record<string, unknown> | undefined) ?? {}
        const nextMeta = { ...session.header.meta, sessionMeta: { ...prev, ...p } }
        const splice: Patch = {
          kind: 'splice',
          span: markerSpan(text, session.header.message.span),
          replacement: markerText(META_ROLE, session.header.name, nextMeta),
        }
        write(sid, applyPatches(text, [splice]))
      },
    },

    assets: {
      async put(sid: string, name: string, data: Uint8Array): Promise<{ ref: string }> {
        assertSafeId(sid, 'session id')
        assertSafeAssetName(name)
        const assetsDir = join(dir, `${sid}.assets`)
        // Containment (§1): even a name that passed assertSafeId must resolve
        // inside assetsDir — belt-and-suspenders against path traversal.
        const target = resolve(assetsDir, name)
        const base = resolve(assetsDir)
        if (target !== base && !target.startsWith(base + sep)) {
          throw new TypeError(`nr-chat-store/nr-chat: asset ${JSON.stringify(name)} escapes ${sid}.assets`)
        }
        if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })
        writeFileSync(target, data)
        return { ref: `file:${sid}.assets/${name}` }
      },
    },

    async version(sid: string): Promise<string> {
      const path = pathOf(sid)
      if (!existsSync(path)) throw new StoreSessionNotFound(sid)
      return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    },
  }

  /** Splice patch of a node's marker line with new meta (body untouched). */
  function markerPatch(text: string, node: SessionNode, meta: Record<string, unknown>): Patch {
    return {
      kind: 'splice',
      span: markerSpan(text, node.message.span),
      replacement: markerText(node.role, node.name, meta),
    }
  }

  // Single-file mode has no multi-session home: fork would overwrite the source
  // (pathOf ignores the id). Drop the method so it matches SINGLE_CAPABILITIES.
  if (single) delete store.forkCopy

  return store
}

/**
 * Rewrite the sidecar refs of `file`/`image` parts from the source sidecar to the
 * fork's: `file:{fromSid}.assets/…` → `file:{toSid}.assets/…`. Other refs
 * (external URLs, foreign sidecars) are left untouched.
 */
function rewriteAssetRefs(parts: Part[], fromSid: string, toSid: string): Part[] {
  const from = `file:${fromSid}.assets/`
  const to = `file:${toSid}.assets/`
  const remap = (ref: string | undefined): string | undefined =>
    typeof ref === 'string' && ref.startsWith(from) ? to + ref.slice(from.length) : ref
  return parts.map((part) => {
    if (part.type === 'file') return { ...part, meta: { ...part.meta, ref: remap(part.meta.ref) } }
    if (part.type === 'image') return { ...part, meta: { ...part.meta, ref: remap(part.meta.ref) } }
    return part
  })
}

// ── nr-chat codec re-exports (subpath `./nr-chat`) ───────────────────────────
// The public boundary wraps the whole chain: codec exports are needed by
// consumers (partToSubMessage and the like — for a future converter, §1). Tree
// math is NOT re-exported here: it lives in the core (main entry).

export {
  parseSession,
  META_ROLE,
  type Session,
  type SessionHeader,
  type SessionNode,
  type SubNode,
} from './session.js'
export {
  assembleParts,
  subNodeToPart,
  partToSubMessage,
  decodeSubBody,
  type PartDecoders,
} from './parts.js'
export { toProtocol, headerToSessionInfo, sessionMetaOf } from './protocol.js'
export {
  appendMessage,
  branchAt,
  swipeTo,
  applyPatches,
  type Patch,
  type MessageInput,
  type MutateOpts,
  type SwipeDir,
} from './mutate.js'
export { toModel, nodeSid, project } from './project.js'
