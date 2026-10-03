/**
 * pi driver (`./pi`) — the middle of the capability range (spec §7.2).
 *
 * JSONL v3, line-surgery: edit = line replacement, append = appending a line,
 * tree by id/parentId. Active leaf = last line (setActiveLeaf = reordering,
 * siblings are not lost). Signatures of edited content are dropped. Format
 * version pinned in opts + a smoke test on drift (NOT-237 pattern).
 *
 * Storage — a directory of pi session `.jsonl` files (recursive scan). Other
 * on-disk forms of the same entries (pi-nr's `.mds`, the `pi/2` profile of
 * pi-session-mds) plug in as `codecs` — the driver stays format-agnostic and
 * does not depend on the codec package.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeInput, SessionInfo, SessionModel, StoreNode } from '../model.js'
import {
  StoreConflictError,
  StoreNodeNotFound,
  StoreSessionNotFound,
  assertSafeId,
  paginate,
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
  type PiSessionHeader,
} from './format.js'
import { applyParts, partsToMessage, toModel } from './codec.js'
import { buildTree, moveToEnd } from './tree-ops.js'
import { readSidechannel, setSidechannelFlags, setSidechannelParts, writeSidechannel } from '../fidelity.js'

export interface PiStoreOpts {
  /** Directory of pi `.jsonl` sessions. */
  dir: string
  /** cwd for the header of new sessions (pi groups by it). Default — `dir`. */
  cwd?: string
  /** Expected pi format version; a mismatch — warn (§7.2, NOT-237 pattern). */
  pinVersion?: number
  warn?: (message: string) => void
  /**
   * Extra file forms of pi sessions, chosen by extension (`.jsonl` is built in).
   * A codec sees the whole file: `decode` → header first, then entries in file
   * order; `encode` — the reverse. E.g. pi-session-mds:
   * `{ ext: '.mds', decode: decodeEntries, encode: encodeEntries }`.
   */
  codecs?: PiFileCodec[]
  /** Extension of NEW sessions (create/fork): `.jsonl` (default) or a codec's `ext`. */
  newSessionExt?: string
  /**
   * Make written messages continuable by pi itself: `timestamp` (ms) on every
   * message; on assistant messages `api`/`provider` from here, `model` and
   * `usage` from node meta, `stopReason` from content (`toolUse` with tool
   * calls, `aborted` for `meta.cancelled`). Off — messages are written as before.
   */
  piMessageDefaults?: { api: string; provider: string }
  /**
   * Служебные записи pi (`model_change`, `thinking_level_change`, `session_info`,
   * `custom`, `label`…) не проецировать в узлы — лента как у backend-pi; дети
   * такой записи подвешиваются к её родителю. Сообщения, скрытые (`mds-hidden`),
   * `compaction`/`branch_summary` остаются. Off — каждая запись узел, как раньше.
   * С опцией у драйвера есть `rename` (запись `session_info`, как `/name` pi) и
   * заголовок сессии — из последней `session_info`.
   */
  piServiceEntries?: 'nodes' | 'hide'
}

/** A non-JSONL file form of pi session entries (see `PiStoreOpts.codecs`). */
export interface PiFileCodec {
  /** Extension with the dot, e.g. `.mds`. */
  ext: string
  decode(text: string): unknown[]
  encode(entries: unknown[]): string
}

const CAPABILITIES: StoreCapabilities = {
  edits: { edit: true, delete: true, hide: true },
  swipes: true,
  fork: true,
}

/** Записи pi, которые остаются узлами при `piServiceEntries: 'hide'`. */
const CONTENT_ENTRY_TYPES = new Set(['message', 'compaction', 'branch_summary'])

export function createPiStore(opts: PiStoreOpts): SessionStore {
  const { dir } = opts
  const cwd = opts.cwd ?? dir
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`))
  const codecs = opts.codecs ?? []
  const newExt = opts.newSessionExt ?? JSONL_EXT
  if (newExt !== JSONL_EXT && !codecs.some((c) => c.ext === newExt)) {
    throw new Error(`nr-chat-store/pi: newSessionExt ${newExt} has no codec`)
  }

  const hideService = opts.piServiceEntries === 'hide'

  /** Проекция файла в модель: все записи — или без служебных (`piServiceEntries`). */
  function project(file: PiSessionFile, sid: string): SessionModel {
    const model = toModel(file, sid)
    if (!hideService) return model
    const kept = new Set<string>()
    const parentOf = new Map<string, string | null>()
    let title: string | undefined
    for (const e of file.entries) {
      parentOf.set(e.id, e.parentId ?? null)
      const hidden = e.type === 'custom' && (e as { customType?: string }).customType === HIDDEN_CUSTOM_TYPE
      if (CONTENT_ENTRY_TYPES.has(e.type) || hidden) kept.add(e.id)
      if (e.type === 'session_info' && typeof (e as { name?: unknown }).name === 'string') title = (e as unknown as { name: string }).name
    }
    const resolve = (id: string | null): string | null => {
      let cur = id
      const seen = new Set<string>()
      while (cur !== null && !kept.has(cur) && !seen.has(cur)) {
        seen.add(cur)
        cur = parentOf.get(cur) ?? null
      }
      return cur !== null && kept.has(cur) ? cur : null
    }
    const nodes = model.nodes.filter((n) => kept.has(n.id)).map((n) => ({ ...n, parent: resolve(n.parent) }))
    const info = { ...model.info, messageCount: nodes.length }
    if (title) info.title = title
    return { info, nodes }
  }

  function codecOf(path: string): PiFileCodec | undefined {
    return codecs.find((c) => path.endsWith(c.ext))
  }

  function isSessionFile(name: string): boolean {
    return name.endsWith(JSONL_EXT) || codecOf(name) !== undefined
  }

  /** File text → parsed file: JSONL by line surgery, codec files whole. */
  function parse(path: string, text: string): PiSessionFile {
    const codec = codecOf(path)
    if (!codec) return parseSessionFile(text)
    const [header, ...entries] = codec.decode(text) as [PiSessionHeader, ...PiEntry[]]
    if (!header || header.type !== 'session' || typeof header.id !== 'string') {
      throw new Error(`nr-chat-store/pi: ${path}: no pi session header`)
    }
    return { header, entries }
  }

  function serialize(path: string, file: PiSessionFile): string {
    const codec = codecOf(path)
    return codec ? codec.encode([file.header, ...file.entries]) : serializeSessionFile(file)
  }

  function fileName(id: string, timestamp: string): string {
    return sessionFileName(id, timestamp).slice(0, -JSONL_EXT.length) + newExt
  }

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
        else if (isSessionFile(name)) {
          try {
            const file = parse(full, readFileSync(full, 'utf-8'))
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

  /** Путь сессии по id, разобранной в последний раз (быстрый путь {@link pathOf}). */
  const known = new Map<string, string>()

  /**
   * Файл сессии по id. Быстрый путь — имя файла: pi кладёт id в него
   * (`<время>_<id>.<ext>`), проверяется только заголовок найденного файла.
   * Полный скан (разбор каждого файла) — запасной: на сотнях сессий он
   * синхронно держит event loop секундами, а зовётся на каждой операции.
   */
  function pathOf(id: string): string {
    assertSafeId(id, 'session id')
    const cached = known.get(id)
    if (cached && headerIdOf(cached) === id) return cached
    for (const path of filesNamed(id)) {
      if (headerIdOf(path) === id) {
        known.set(id, path)
        return path
      }
    }
    const path = scan().get(id)
    if (!path) throw new StoreSessionNotFound(id)
    known.set(id, path)
    return path
  }

  /** Файлы сессий, в имени которых стоит `_<id>.` — без разбора содержимого. */
  function filesNamed(id: string): string[] {
    const out: string[] = []
    const walk = (root: string): void => {
      if (!existsSync(root)) return
      for (const name of readdirSync(root)) {
        const full = join(root, name)
        if (isSessionFile(name)) {
          if (name.includes(`_${id}.`)) out.push(full)
          continue
        }
        try {
          if (statSync(full).isDirectory()) walk(full)
        } catch {
          /* исчез — пропустить */
        }
      }
    }
    walk(dir)
    return out
  }

  function headerIdOf(path: string): string | undefined {
    try {
      return parse(path, readFileSync(path, 'utf-8')).header.id
    } catch {
      return undefined
    }
  }

  function read(id: string): { path: string; file: PiSessionFile } {
    const path = pathOf(id)
    return { path, file: parse(path, readFileSync(path, 'utf-8')) }
  }

  function write(path: string, file: PiSessionFile): void {
    writeFileSync(path, serialize(path, file), 'utf-8')
  }

  function requireEntry(file: PiSessionFile, nid: string): PiEntry {
    const entry = file.entries.find((e) => e.id === nid)
    if (!entry) throw new StoreNodeNotFound(nid)
    return entry
  }

  function returnNode(file: PiSessionFile, sid: string, nid: string): StoreNode {
    const node = project(file, sid).nodes.find((n) => n.id === nid)
    if (!node) throw new StoreNodeNotFound(nid)
    return node
  }

  function infoOf(sid: string, path: string, file: PiSessionFile): SessionInfo {
    const model = project(file, sid)
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

    async list(opts): Promise<{ sessions: SessionInfo[]; cursor?: string }> {
      const sessions: SessionInfo[] = []
      for (const [sid, path] of scan()) {
        try {
          sessions.push(infoOf(sid, path, parse(path, readFileSync(path, 'utf-8'))))
        } catch (err) {
          warn(`nr-chat-store/pi: skipping ${path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      const page = paginate(sessions, opts)
      return page.cursor !== undefined ? { sessions: page.items, cursor: page.cursor } : { sessions: page.items }
    },

    async load(id: string): Promise<SessionModel> {
      const { file } = read(id)
      return project(file, id)
    },

    async create(createOpts): Promise<SessionInfo> {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const now = new Date()
      const timestamp = now.toISOString()
      const id = createOpts?.id !== undefined ? assertSafeId(createOpts.id, 'session id') : uuidv7(now.getTime())
      const path = join(dir, fileName(id, timestamp))
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

      // id-first (§2): honor NodeInput.id verbatim (+assertSafeId, +duplicate
      // reject); pi stops generating its own when an id is given.
      let id: string
      if (node.id !== undefined) {
        id = assertSafeId(node.id, 'node id')
        if (taken.has(id)) throw new Error(`nr-chat-store/pi: node id ${JSON.stringify(id)} already exists in session ${sid}`)
      } else {
        id = entryId(taken)
      }

      const parts = partsOf(node)
      const message = partsToMessage(node.role, node.name, parts)
      if (opts.piMessageDefaults) withPiDefaults(message, parts, node.meta, opts.piMessageDefaults)
      let entry: PiEntry = {
        type: 'message',
        id,
        parentId: parentId ?? null,
        timestamp: new Date().toISOString(),
        message,
      }
      // Fidelity (§3): park the whole neutral node so every Part/flag/meta
      // survives, even what pi can't express natively. Native content is written
      // above for pi's own tooling; the sidechannel is authoritative on our read.
      writeSidechannel(entry as unknown as Record<string, unknown>, node.role, parts, node.flags, node.meta, node.name)
      if (node.flags?.disabled || node.flags?.hidden) entry = wrapHidden(entry as PiMessageEntry)

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
      const edited = editEntry(entry, parts, current.role)
      // Keep the fidelity sidechannel (§3) in sync — otherwise a stale copy would
      // shadow the edit on the next load.
      setSidechannelParts(edited as unknown as Record<string, unknown>, parts)
      const next = replaceEntry(file, edited)
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

      let next: PiEntry
      if (hidden) {
        if (entry.type !== 'message') {
          throw new Error(`nr-chat-store/pi: entry ${nid} of type "${entry.type}" can't be hidden`)
        }
        next = wrapHidden(entry as PiMessageEntry)
      } else {
        next = unwrapHidden(entry)
      }
      // Sync the fidelity sidechannel flags (§3) so the sidechannel (authoritative
      // on read) agrees with the native mds-hidden wrapper.
      const rec = next as unknown as Record<string, unknown>
      const sc = readSidechannel(rec)
      if (sc) {
        const flags = { ...(sc.flags ?? {}) }
        if (hidden) flags.disabled = true
        else { delete flags.disabled; delete flags.hidden }
        setSidechannelFlags(rec, flags)
      }
      write(path, replaceEntry(file, next))
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
      const dst = join(dir, fileName(newId, timestamp))
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

  // rename — запись session_info ребёнком последней записи (как `/name` pi);
  // только когда служебные записи скрыты, иначе она всплыла бы узлом в ленте.
  if (hideService) {
    store.rename = async (sid: string, title: string): Promise<void> => {
      const { path, file } = read(sid)
      const taken = new Set(file.entries.map((e) => e.id))
      const last = file.entries.length ? file.entries[file.entries.length - 1]!.id : null
      const entry = { type: 'session_info', id: entryId(taken), parentId: last, timestamp: new Date().toISOString(), name: title } as PiEntry
      write(path, { ...file, entries: [...file.entries, entry] })
    }
    store.capabilities = async () => ({ ...CAPABILITIES, rename: true })
  }

  return store
}

// ── entry helpers ──────────────────────────────────────────────────────────────

const JSONL_EXT = '.jsonl'

/** `PiStoreOpts.piMessageDefaults`: fields pi needs to continue a session we wrote. */
function withPiDefaults(
  message: PiAgentMessage,
  parts: import('../model.js').Part[],
  meta: Record<string, unknown> | undefined,
  defaults: { api: string; provider: string },
): void {
  const m = message as Record<string, unknown>
  if (m.timestamp === undefined) m.timestamp = Date.now()
  if (message.role !== 'assistant') return
  if (m.api === undefined) m.api = defaults.api
  if (m.provider === undefined) m.provider = defaults.provider
  if (m.model === undefined) m.model = typeof meta?.model === 'string' ? meta.model : 'unknown'
  if (m.usage === undefined) {
    const u = (meta?.usage ?? {}) as { input?: unknown; output?: unknown }
    const input = typeof u.input === 'number' ? u.input : 0
    const output = typeof u.output === 'number' ? u.output : 0
    m.usage = {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
  }
  if (m.stopReason === undefined) {
    m.stopReason = meta?.cancelled === true ? 'aborted' : parts.some((p) => p.type === 'tool_use') ? 'toolUse' : 'stop'
  }
}

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
