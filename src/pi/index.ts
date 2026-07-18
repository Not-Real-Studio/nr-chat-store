/**
 * pi driver (`./pi`) — the middle of the capability range (spec §7.2).
 *
 * JSONL v3, line-surgery: edit = line replacement, append = appending a line,
 * tree by id/parentId. Active leaf = last line (setActiveLeaf = reordering,
 * siblings are not lost). Signatures of edited content are dropped. Format
 * version pinned in opts + a smoke test on drift (NOT-237 pattern).
 *
 * Storage — a directory of pi session `.jsonl` files (recursive scan).
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeInput, SessionInfo, SessionModel, StoreNode } from '../model.js'
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
import {
  HIDDEN_CUSTOM_TYPE,
  PI_SESSION_VERSION,
  entryId,
  newSessionHeader,
  parseSessionFile,
  sessionFileName,
  serializeSessionFile,
  uuidv7,
  type PiAgentMessage,
  type PiEntry,
  type PiMessageEntry,
  type PiSessionFile,
} from './format.js'
import { applyParts, partsToMessage, toModel } from './codec.js'
import { buildTree, moveToEnd } from './tree-ops.js'

export interface PiStoreOpts {
  /** Directory of pi `.jsonl` sessions. */
  dir: string
  /** cwd for the header of new sessions (pi groups by it). Default — `dir`. */
  cwd?: string
  /** Expected pi format version; a mismatch — warn (§7.2, NOT-237 pattern). */
  pinVersion?: number
  warn?: (message: string) => void
}

const CAPABILITIES: StoreCapabilities = {
  edits: { edit: true, delete: true, hide: true },
  swipes: true,
  fork: true,
}

export function createPiStore(opts: PiStoreOpts): SessionStore {
  const { dir } = opts
  const cwd = opts.cwd ?? dir
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`))

  /** Recursive directory scan: session id (from header) → file path. */
  function scan(): Map<string, string> {
    const found = new Map<string, string>()
    const walk = (root: string): void => {
      if (!existsSync(root)) return
      for (const name of readdirSync(root)) {
        const full = join(root, name)
        let st
        try {
          st = statSync(full)
        } catch {
          continue
        }
        if (st.isDirectory()) walk(full)
        else if (name.endsWith('.jsonl')) {
          try {
            const file = parseSessionFile(readFileSync(full, 'utf-8'))
            checkVersion(file)
            found.set(file.header.id, full)
          } catch {
            /* broken file — skip */
          }
        }
      }
    }
    walk(dir)
    return found
  }

  let warnedVersion = false
  function checkVersion(file: PiSessionFile): void {
    const pin = opts.pinVersion
    const ver = file.header.version ?? 1
    if (pin !== undefined && ver !== pin && !warnedVersion) {
      warnedVersion = true
      warn(`nr-chat-store/pi: format version ${ver} != pinVersion ${pin} — possible spec drift`)
    }
  }

  function pathOf(id: string): string {
    const path = scan().get(id)
    if (!path) throw new StoreSessionNotFound(id)
    return path
  }

  function read(id: string): { path: string; file: PiSessionFile } {
    const path = pathOf(id)
    return { path, file: parseSessionFile(readFileSync(path, 'utf-8')) }
  }

  function write(path: string, file: PiSessionFile): void {
    writeFileSync(path, serializeSessionFile(file), 'utf-8')
  }

  function requireEntry(file: PiSessionFile, nid: string): PiEntry {
    const entry = file.entries.find((e) => e.id === nid)
    if (!entry) throw new StoreNodeNotFound(nid)
    return entry
  }

  function returnNode(file: PiSessionFile, sid: string, nid: string): StoreNode {
    const node = toModel(file, sid).nodes.find((n) => n.id === nid)
    if (!node) throw new StoreNodeNotFound(nid)
    return node
  }

  function infoOf(sid: string, path: string, file: PiSessionFile): SessionInfo {
    const model = toModel(file, sid)
    const info = model.info
    try {
      info.updatedAt = new Date(statSync(path).mtimeMs).toISOString()
    } catch {
      /* file was pulled out from under us — don't crash */
    }
    return info
  }

  const store: SessionStore = {
    async capabilities(): Promise<StoreCapabilities> {
      return CAPABILITIES
    },

    async list(): Promise<{ sessions: SessionInfo[] }> {
      const sessions: SessionInfo[] = []
      for (const [sid, path] of scan()) {
        try {
          sessions.push(infoOf(sid, path, parseSessionFile(readFileSync(path, 'utf-8'))))
        } catch (err) {
          warn(`nr-chat-store/pi: skipping ${path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      return { sessions }
    },

    async load(id: string): Promise<SessionModel> {
      const { file } = read(id)
      return toModel(file, id)
    },

    async create(createOpts): Promise<SessionInfo> {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const now = new Date()
      const timestamp = now.toISOString()
      const id = createOpts?.id ?? uuidv7(now.getTime())
      const path = join(dir, sessionFileName(id, timestamp))
      const header = newSessionHeader(id, cwd, timestamp)
      const file: PiSessionFile = { header, entries: [] }
      write(path, file)
      const info: SessionInfo = { id, createdAt: timestamp, messageCount: 0 }
      if (createOpts?.info?.title) info.title = createOpts.info.title
      return info
    },

    async delete(id: string): Promise<void> {
      unlinkSync(pathOf(id))
    },

    async appendNode(sid: string, node: NodeInput): Promise<StoreNode> {
      const { path, file } = read(sid)
      const taken = new Set(file.entries.map((e) => e.id))
      const parentId =
        node.parent !== undefined ? node.parent : file.entries.length ? file.entries[file.entries.length - 1].id : null

      const message = partsToMessage(node.role, node.name, partsOf(node))
      let entry: PiEntry = {
        type: 'message',
        id: entryId(taken),
        parentId: parentId ?? null,
        timestamp: new Date().toISOString(),
        message,
      }
      if (node.flags?.hidden) entry = wrapHidden(entry as PiMessageEntry)

      const next = { ...file, entries: [...file.entries, entry] }
      write(path, next)
      return returnNode(next, sid, entry.id)
    },

    async editNode(sid: string, nid: string, patch: NodePatch): Promise<StoreNode> {
      const { path, file } = read(sid)
      const current = returnNode(file, sid, nid)
      if (patch.ifHash !== undefined && contentHash(current.role, current.parts) !== patch.ifHash) {
        throw new StoreConflictError(nid)
      }
      const parts = patch.parts ?? (patch.text !== undefined ? replaceTextParts(current.parts, patch.text) : undefined)
      if (!parts) throw new Error('nr-chat-store/pi: editNode — parts or text required')

      const entry = requireEntry(file, nid)
      const next = replaceEntry(file, editEntry(entry, parts, current.role))
      write(path, next)
      return returnNode(next, sid, nid)
    },

    async deleteNode(sid: string, nid: string): Promise<void> {
      const { path, file } = read(sid)
      const target = requireEntry(file, nid)
      const entries = file.entries
        .filter((e) => e.id !== nid)
        .map((e) => (e.parentId === nid ? ({ ...e, parentId: target.parentId } as PiEntry) : e))
      write(path, { ...file, entries })
    },

    async hideNode(sid: string, nid: string, hidden: boolean): Promise<void> {
      const { path, file } = read(sid)
      const entry = requireEntry(file, nid)
      const isHidden =
        entry.type === 'custom' && (entry as { customType?: string }).customType === HIDDEN_CUSTOM_TYPE
      if (hidden === isHidden) return

      if (hidden) {
        if (entry.type !== 'message') {
          throw new Error(`nr-chat-store/pi: entry ${nid} of type "${entry.type}" can't be hidden`)
        }
        write(path, replaceEntry(file, wrapHidden(entry as PiMessageEntry)))
      } else {
        write(path, replaceEntry(file, unwrapHidden(entry)))
      }
    },

    async setActiveLeaf(sid: string, nid: string): Promise<void> {
      const { path, file } = read(sid)
      requireEntry(file, nid)
      write(path, { ...file, entries: moveToEnd(file.entries, nid) })
    },

    async forkCopy(sid: string, atNodeId?: string): Promise<SessionInfo> {
      const { file } = read(sid)
      const tree = buildTree(file.entries)
      const leafId = atNodeId ?? tree.leafId
      if (!leafId) throw new Error(`nr-chat-store/pi: session ${sid} is empty — nothing to fork`)
      if (!tree.byId.has(leafId)) throw new StoreNodeNotFound(leafId)

      const path: PiEntry[] = []
      for (let node = tree.byId.get(leafId) ?? null; node; node = node.parent) path.unshift(node.entry)

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const now = new Date()
      const timestamp = now.toISOString()
      const newId = uuidv7(now.getTime())
      const dst = join(dir, sessionFileName(newId, timestamp))
      const header = { ...newSessionHeader(newId, file.header.cwd, timestamp), parentSession: sid }
      write(dst, { header, entries: path })

      const info: SessionInfo = { id: newId, createdAt: timestamp, parentSessionId: sid, messageCount: path.length }
      if (atNodeId) info.forkMessageId = atNodeId
      return info
    },

    async version(sid: string): Promise<string> {
      const { path } = read(sid)
      return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
    },
  }

  return store
}

// ── entry helpers ──────────────────────────────────────────────────────────────

function replaceEntry(file: PiSessionFile, next: PiEntry): PiSessionFile {
  return { ...file, entries: file.entries.map((e) => (e.id === next.id ? next : e)) }
}

/** Replace the content of a message entry (or a wrapped hidden one) with new parts. */
function editEntry(entry: PiEntry, parts: import('../model.js').Part[], role: string): PiEntry {
  if (entry.type === 'custom' && (entry as { customType?: string }).customType === HIDDEN_CUSTOM_TYPE) {
    const wrapper = entry as PiEntry & { data?: { message?: PiAgentMessage } }
    const inner = wrapper.data?.message
    if (!inner) throw new Error(`nr-chat-store/pi: entry ${entry.id} contains no hidden message`)
    const nextInner = partsToMessage(role, undefined, parts)
    return { ...wrapper, data: { ...wrapper.data, message: { ...inner, ...nextInner } } } as PiEntry
  }
  if (entry.type !== 'message') {
    throw new Error(`nr-chat-store/pi: entry ${entry.id} of type "${entry.type}" is not editable`)
  }
  return applyParts(entry as PiMessageEntry, parts)
}

function wrapHidden(entry: PiMessageEntry): PiEntry {
  const { message, ...chain } = entry
  return { ...chain, type: 'custom', customType: HIDDEN_CUSTOM_TYPE, data: { message } } as unknown as PiEntry
}

function unwrapHidden(entry: PiEntry): PiEntry {
  const wrapper = entry as PiEntry & { data?: { message?: PiAgentMessage }; customType?: string }
  const inner = wrapper.data?.message
  if (!inner) throw new Error(`nr-chat-store/pi: entry ${entry.id} contains no hidden message`)
  const { customType: _c, data: _d, ...chain } = wrapper
  return { ...chain, type: 'message', message: inner } as unknown as PiEntry
}
