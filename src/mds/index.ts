/**
 * mds-драйвер (`./mds`) — полный набор capabilities (spec §7.1).
 *
 * Растёт из nr-session: parse/патчи/partToSubMessage/tree импортируются, не
 * копируются — nr-session живёт как есть, драйвер = обвязка контракта над ним.
 * Спан-хирургия: байты вне спана операции не переписываются (§5). `decoders` —
 * опция драйвера (toon не зависимость). Сайдкар-ассеты — `{id}.assets/`.
 *
 * Хранилище — каталог `.mds`-файлов, один на сессию (`{id}.mds`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { stringify } from '@notrealstudio/nr-chat'
import type { ChatMessage, Span } from '@notrealstudio/nr-chat'
import {
  META_ROLE,
  appendMessage,
  applyPatches,
  assembleParts,
  branchAt,
  parseSession,
  partToSubMessage,
  resolveTree,
  activeLeaf as sessionActiveLeaf,
  type Patch,
  type PartDecoders,
  type Session,
  type SessionNode,
} from '@notreal/nr-session'
import type { MessageFlags, NodeInput, Part, SessionInfo, SessionModel, StoreNode } from '../model.js'
import {
  StoreConflictError,
  StoreNodeNotFound,
  StoreSessionNotFound,
  partsOf,
  replaceTextParts,
  type NodePatch,
  type SessionStore,
  type StoreCapabilities,
} from '../store.js'
import { contentHash } from '../tree.js'
import { nodeSid, toModel } from './project.js'

export interface MdsStoreOpts {
  /** Каталог с `.mds`-файлами сессий. */
  dir: string
  /** Инъекция декодеров body по `format` (toon и пр.). */
  decoders?: PartDecoders
}

const CAPABILITIES: StoreCapabilities = {
  edits: { edit: true, delete: true, hide: true },
  swipes: true,
  fork: true,
  assets: true,
  sessionMeta: true,
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Фабрика mds-драйвера (spec §6/§7.1). */
export function createMdsStore(opts: MdsStoreOpts): SessionStore {
  const { dir, decoders } = opts

  function pathOf(id: string): string {
    return join(dir, `${id}.mds`)
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

  /** Уникальный в файле короткий id (4 base36) — для проставления ленивых id. */
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

  /** Ссылка на узел: явный id либо позиционный `pos:N`. */
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
    const leaf = sessionActiveLeaf(session)
    return leaf ? nodeSid(leaf) : undefined
  }

  /** Мета для записи: слить flags в словарь меты. */
  function withFlags(meta: Record<string, unknown> | undefined, flags: MessageFlags | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = { ...(meta ?? {}) }
    if (flags?.hidden) out.hidden = true
    if (flags?.frozen) out.frozen = true
    if (flags?.injected) out.injected = true
    return out
  }

  // ── сериализация узла ──────────────────────────────────────────────────────

  /** Части + мета → текст mds-узла (обычная нода + `%%`-суб-ноды), без хвостового `\n`. */
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

  /** Только маркер-строка (первая строка спана узла): правка меты, тело цело. */
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

  /** Спан узла-группы вместе с хвостовым `\n` (для полного удаления). */
  function groupSpanWithNewline(text: string, node: SessionNode): Span {
    let end = node.span.end
    if (text[end] === '\n') end += 1
    else if (node.span.start > 0 && text[node.span.start - 1] === '\n') {
      // хвостовой ноды: съедаем ведущий перевод строки
      return { start: node.span.start - 1, end: node.span.end }
    }
    return { start: node.span.start, end }
  }

  /** Проекция того же узла, на который указывал `ref` (позиция стабильна при edit). */
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

  // ── контракт ────────────────────────────────────────────────────────────────

  const store: SessionStore = {
    async capabilities(): Promise<StoreCapabilities> {
      return CAPABILITIES
    },

    async list(): Promise<{ sessions: SessionInfo[] }> {
      const sessions: SessionInfo[] = []
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
            /* файл увели — не роняем список */
          }
          sessions.push(info)
        } catch {
          /* битый файл — warn+skip (§8) */
        }
      }
      sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      return { sessions }
    },

    async load(id: string): Promise<SessionModel> {
      const { session } = read(id)
      const model = toModel(session, decoders)
      model.info.id = id
      return model
    },

    async create(createOpts): Promise<SessionInfo> {
      const id = createOpts?.id ?? randomUUID()
      if (existsSync(pathOf(id))) throw new Error(`chat-store/mds: сессия ${id} уже существует`)
      const meta: Record<string, unknown> = { id }
      const info = createOpts?.info
      if (info?.title) meta.title = info.title
      meta.createdAt = info?.createdAt ?? new Date().toISOString()
      write(id, markerText(META_ROLE, undefined, meta) + '\n')
      return { id, title: info?.title, createdAt: meta.createdAt as string, messageCount: 0 }
    },

    async delete(id: string): Promise<void> {
      const path = pathOf(id)
      if (!existsSync(path)) throw new StoreSessionNotFound(id)
      unlinkSync(path)
    },

    async appendNode(sid: string, node: NodeInput): Promise<StoreNode> {
      const { text, session } = read(sid)
      // Явный id новому узлу (eager): id стабилен для контракта (§3), не зависит
      // от позиции — переживает последующие branch/delete соседей.
      const meta = withFlags(node.meta, node.flags)
      if (meta.id === undefined) meta.id = idFactory(session)()
      const input = { role: node.role, name: node.name, meta, parts: partsOf(node) }
      const parent = node.parent
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
      if (!parts) throw new Error('chat-store/mds: editNode — нужен parts либо text')

      const splice: Patch = { kind: 'splice', span: node.span, replacement: nodeText(node.role, node.name, node.meta ?? {}, parts) }
      write(sid, applyPatches(text, [splice]))
      return returnNode(sid, nid)
    },

    async deleteNode(sid: string, nid: string): Promise<void> {
      const { text, session } = read(sid)
      const target = requireNode(session, nid)
      const tree = resolveTree(session.nodes)
      const parent = tree.parentOf.get(target) ?? null
      const genId = idFactory(session)

      const patches: Patch[] = []
      let parentId = parent?.id ?? null
      if (parent && !parentId) {
        parentId = genId()
        patches.push(markerPatch(text, parent, { ...(parent.meta ?? {}), id: parentId }))
      }

      // Дети перецепляются на родителя удаляемого (§5): явный parent в маркере.
      for (const child of tree.childrenOf.get(target) ?? []) {
        const meta = { ...(child.meta ?? {}) }
        if (parentId === null) delete meta.parent
        else meta.parent = parentId
        patches.push(markerPatch(text, child, meta))
      }

      // currNode на удаляемом — переставить на родителя (или снять).
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
      if (hidden) meta.hidden = true
      else delete meta.hidden
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
        // Нет хедера — синтезируем `%meta {currNode}` в начало файла.
        const header = markerText(META_ROLE, undefined, { id: sid, currNode: leafId })
        const withNode = applyPatches(text, patches)
        write(sid, `${header}\n${withNode}`)
      }
    },

    async forkCopy(sid: string, atNodeId?: string): Promise<SessionInfo> {
      const { session } = read(sid)
      const tree = resolveTree(session.nodes)
      const leaf = atNodeId ? requireNode(session, atNodeId) : sessionActiveLeaf(session)
      if (!leaf) throw new Error(`chat-store/mds: сессия ${sid} пуста — форкать нечего`)

      // Путь root→leaf: линейная перепись без id/parent (chain default).
      const path: SessionNode[] = []
      for (let n: SessionNode | null | undefined = leaf; n; n = tree.parentOf.get(n) ?? null) path.unshift(n)

      const newId = randomUUID()
      const createdAt = new Date().toISOString()
      const headerMeta: Record<string, unknown> = { id: newId, createdAt, parentSessionId: sid }
      if (atNodeId) headerMeta.forkMessageId = atNodeId
      if (session.header?.meta.title) headerMeta.title = session.header.meta.title

      const lines = [markerText(META_ROLE, undefined, headerMeta)]
      for (const node of path) {
        const meta = { ...(node.meta ?? {}) }
        delete meta.id
        delete meta.parent
        lines.push(nodeText(node.role, node.name, meta, assembleParts(node, decoders)))
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
        for (const sub of session.header?.subNodes ?? []) out[sub.kind] = sub.body
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
        const assetsDir = join(dir, `${sid}.assets`)
        if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })
        writeFileSync(join(assetsDir, name), data)
        return { ref: `file:${sid}.assets/${name}` }
      },
    },

    async version(sid: string): Promise<string> {
      const path = pathOf(sid)
      if (!existsSync(path)) throw new StoreSessionNotFound(sid)
      return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    },
  }

  /** Splice-патч маркер-строки узла с новой метой (тело нетронуто). */
  function markerPatch(text: string, node: SessionNode, meta: Record<string, unknown>): Patch {
    return {
      kind: 'splice',
      span: markerSpan(text, node.message.span),
      replacement: markerText(node.role, node.name, meta),
    }
  }

  return store
}
