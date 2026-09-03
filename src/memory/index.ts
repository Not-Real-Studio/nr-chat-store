/**
 * memory driver (`./memory`) — in-process store, full capability set (spec §7).
 *
 * No filesystem, no codec: the neutral `StoreNode[]` IS the storage, so every
 * Part/flag/meta survives natively (no fidelity sidechannel needed). Replaces
 * the engine's old MemorySession and backs both the engine conformance tests
 * (fast, no disk) and one-shot tasks (translate/extract) that assemble a prompt,
 * use the answer, and forget it.
 *
 * Mutation semantics mirror the nr-chat driver: id-first append (duplicate id
 * rejected, parent unset → active leaf, `null` → root, string → branch),
 * deleteNode re-parents children onto the deleted node's parent, setActiveLeaf
 * moves `meta.activeLeaf`, editNode guards with `ifHash` via contentHash,
 * forkCopy copies the active path root→leaf into a fresh session.
 */

import { randomUUID } from 'node:crypto'
import type { NodeInput, SessionInfo, SessionModel, StoreNode } from '../model.js'
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
import { activeLeaf, contentHash, resolveTree } from '../tree.js'

export interface MemoryStoreOpts {
  /** Preloaded sessions (tests / one-shot seeding). Cloned on construction. */
  seed?: SessionModel[]
}

/** In-process store — everything on, nothing gated. */
const CAPABILITIES: StoreCapabilities = {
  edits: { edit: true, delete: true, hide: true },
  swipes: true,
  fork: true,
  rename: true,
  assets: true,
  sessionMeta: true,
}

const clone = <T>(v: T): T => structuredClone(v)

function nowIso(): string {
  return new Date().toISOString()
}

/** Deterministic content fingerprint of a whole session (FNV-1a 32-bit). */
function versionOf(model: SessionModel): string {
  const canonical = JSON.stringify({ nodes: model.nodes, activeLeaf: model.meta?.activeLeaf })
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function createMemoryStore(opts: MemoryStoreOpts = {}): SessionStore {
  const sessions = new Map<string, SessionModel>()
  const assetBlobs = new Map<string, Map<string, Uint8Array>>()

  for (const s of opts.seed ?? []) {
    const m = clone(s)
    if (!m.meta) m.meta = {}
    sessions.set(m.info.id, m)
  }

  function need(sid: string): SessionModel {
    assertSafeId(sid, 'session id')
    const model = sessions.get(sid)
    if (!model) throw new StoreSessionNotFound(sid)
    return model
  }

  function findNode(model: SessionModel, nid: string): StoreNode {
    const node = model.nodes.find((n) => n.id === nid)
    if (!node) throw new StoreNodeNotFound(nid)
    return node
  }

  function touch(model: SessionModel): void {
    model.info.updatedAt = nowIso()
    model.info.messageCount = model.nodes.length
  }

  const store: SessionStore = {
    async capabilities(): Promise<StoreCapabilities> {
      return CAPABILITIES
    },

    async list(listOpts): Promise<{ sessions: SessionInfo[]; cursor?: string }> {
      const infos = [...sessions.values()]
        .map((m) => clone(m.info))
        .sort((a, b) => (b.updatedAt ?? b.createdAt ?? '').localeCompare(a.updatedAt ?? a.createdAt ?? ''))
      const page = paginate(infos, listOpts)
      return page.cursor !== undefined ? { sessions: page.items, cursor: page.cursor } : { sessions: page.items }
    },

    async load(id: string): Promise<SessionModel> {
      return clone(need(id))
    },

    async create(createOpts): Promise<SessionInfo> {
      const id = createOpts?.id !== undefined ? assertSafeId(createOpts.id, 'session id') : randomUUID()
      if (sessions.has(id)) throw new Error(`nr-chat-store/memory: session ${id} already exists`)
      const created = nowIso()
      const info: SessionInfo = { ...(createOpts?.info ?? {}), id, createdAt: created, updatedAt: created, messageCount: 0 }
      sessions.set(id, { info, meta: {}, nodes: [] })
      return clone(info)
    },

    async delete(id: string): Promise<void> {
      assertSafeId(id, 'session id')
      sessions.delete(id)
      assetBlobsFor(id).clear()
    },

    async rename(id: string, title: string): Promise<void> {
      const model = need(id)
      model.info.title = title
      model.info.updatedAt = nowIso()
    },

    async appendNode(sid: string, input: NodeInput): Promise<StoreNode> {
      const model = need(sid)

      // parent unset → active leaf (extends the active path); explicit `null` →
      // root; explicit id → branch. Only extending the active path moves the leaf.
      const extendsActive = input.parent === undefined
      const parent = extendsActive ? activeLeaf(model)?.id ?? null : input.parent!

      let id: string
      if (input.id !== undefined) {
        id = assertSafeId(input.id, 'node id')
        if (model.nodes.some((n) => n.id === id)) {
          throw new Error(`nr-chat-store/memory: node id ${JSON.stringify(id)} already exists in session ${sid}`)
        }
      } else {
        id = randomUUID()
      }

      const node: StoreNode = { id, parent, role: input.role, parts: clone(partsOf(input)) }
      if (input.name !== undefined) node.name = input.name
      if (input.flags && Object.keys(input.flags).length) node.flags = clone(input.flags)
      const meta: Record<string, unknown> = { createdAt: nowIso(), ...clone(input.meta ?? {}) }
      node.meta = meta

      model.nodes.push(node)
      if (extendsActive) model.meta!.activeLeaf = id
      touch(model)
      return clone(node)
    },

    async editNode(sid: string, nid: string, patch: NodePatch): Promise<StoreNode> {
      const model = need(sid)
      const node = findNode(model, nid)
      if (patch.ifHash !== undefined && contentHash(node.role, node.parts) !== patch.ifHash) {
        throw new StoreConflictError(nid)
      }
      if (patch.parts !== undefined) node.parts = clone(patch.parts)
      else if (patch.text !== undefined) node.parts = replaceTextParts(node.parts, patch.text)
      model.info.updatedAt = nowIso()
      return clone(node)
    },

    async deleteNode(sid: string, nid: string): Promise<void> {
      const model = need(sid)
      const node = findNode(model, nid)
      // Children re-parent onto the deleted node's parent (§5).
      for (const n of model.nodes) if (n.parent === nid) n.parent = node.parent
      model.nodes = model.nodes.filter((n) => n.id !== nid)
      if (model.meta!.activeLeaf === nid) model.meta!.activeLeaf = node.parent ?? undefined
      touch(model)
    },

    async hideNode(sid: string, nid: string, hidden: boolean): Promise<void> {
      const model = need(sid)
      const node = findNode(model, nid)
      const flags = { ...(node.flags ?? {}) }
      if (hidden) flags.disabled = true
      else { delete flags.disabled; delete flags.hidden }
      node.flags = Object.keys(flags).length ? flags : undefined
      model.info.updatedAt = nowIso()
    },

    async setActiveLeaf(sid: string, nid: string): Promise<void> {
      const model = need(sid)
      findNode(model, nid) // existence check
      model.meta!.activeLeaf = nid
    },

    async forkCopy(sid: string, atNodeId?: string): Promise<SessionInfo> {
      const model = need(sid)
      const tree = resolveTree(model.nodes)
      let leaf: StoreNode | undefined
      if (atNodeId !== undefined) {
        leaf = tree.byId.get(atNodeId)
        if (!leaf) throw new StoreNodeNotFound(atNodeId)
      } else {
        leaf = activeLeaf(model, tree)
      }
      if (!leaf) throw new Error(`nr-chat-store/memory: session ${sid} is empty — nothing to fork`)

      const chain: StoreNode[] = []
      const seen = new Set<StoreNode>()
      for (let cur: StoreNode | null | undefined = leaf; cur && !seen.has(cur); ) {
        seen.add(cur)
        chain.unshift(cur)
        cur = tree.parentOf.get(cur) ?? null
      }

      const newId = randomUUID()
      const created = nowIso()
      const info: SessionInfo = { id: newId, createdAt: created, updatedAt: created, parentSessionId: sid, messageCount: chain.length }
      if (atNodeId !== undefined) info.forkMessageId = atNodeId
      sessions.set(newId, { info, meta: { activeLeaf: leaf.id }, nodes: clone(chain) })
      return clone(info)
    },

    meta: {
      async get(sid: string): Promise<Record<string, unknown>> {
        return clone(need(sid).meta ?? {})
      },
      async patch(sid: string, p: Record<string, unknown>): Promise<void> {
        const model = need(sid)
        Object.assign(model.meta!, clone(p))
        model.info.updatedAt = nowIso()
      },
    },

    assets: {
      async put(sid: string, name: string, data: Uint8Array, _mime?: string): Promise<{ ref: string }> {
        need(sid)
        assertSafeAssetName(name)
        assetBlobsFor(sid).set(name, data.slice())
        return { ref: `mem://${sid}/${name}` }
      },
    },

    async version(sid: string): Promise<string> {
      return versionOf(need(sid))
    },
  }

  function assetBlobsFor(sid: string): Map<string, Uint8Array> {
    let m = assetBlobs.get(sid)
    if (!m) {
      m = new Map()
      assetBlobs.set(sid, m)
    }
    return m
  }

  return store
}
