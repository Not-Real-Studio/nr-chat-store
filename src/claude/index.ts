/**
 * claude-драйвер (`./claude`) — минимум набора: read + append (spec §7.3).
 *
 * Транскрипты Agent SDK (`~/.claude/projects`, JSONL): дерево по uuid/parentUuid,
 * записи многих типов (user/assistant/system + meta-строки без uuid). Драйвер
 * читает (list/load, битые строки → warn+skip) и дозаписывает (appendNode,
 * forkCopy) — append-only, поэтому нетронутые строки verbatim по построению.
 * edit/delete/hide/swipes — capabilities false (v1): формат SDK их не даёт дёшево.
 *
 * Потребители: claude-sess (чтение/архив/корпус), экспорт корпусов Julia.
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageFlags, NodeInput, Part, SessionInfo, SessionModel, StoreNode } from '../model.js'
import {
  StoreSessionNotFound,
  partsOf,
  type SessionStore,
  type StoreCapabilities,
} from '../store.js'

export interface ClaudeStoreOpts {
  /** Каталог транскриптов (проект `~/.claude/projects/<slug>` либо корень). */
  dir: string
  /** cwd для дозаписываемых записей. Default — `dir`. */
  cwd?: string
  warn?: (message: string) => void
}

const CAPABILITIES: StoreCapabilities = {
  edits: { edit: false, delete: false, hide: false },
  swipes: false,
  fork: true,
}

interface ClaudeEntry {
  uuid?: string
  parentUuid?: string | null
  type?: string
  message?: { role?: string; content?: unknown; model?: string }
  timestamp?: string
  isSidechain?: boolean
  isMeta?: boolean
  sessionId?: string
  [k: string]: unknown
}

export function createClaudeStore(opts: ClaudeStoreOpts): SessionStore {
  const { dir } = opts
  const cwd = opts.cwd ?? dir
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`${m}\n`))

  /** Рекурсивный скан: id сессии (имя файла без .jsonl) → путь. */
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
        else if (name.endsWith('.jsonl')) found.set(name.slice(0, -6), full)
      }
    }
    walk(dir)
    return found
  }

  function pathOf(id: string): string {
    const path = scan().get(id)
    if (!path) throw new StoreSessionNotFound(id)
    return path
  }

  /** Строки файла → записи, битые скипаются (warn). */
  function readEntries(path: string, id: string): ClaudeEntry[] {
    const out: ClaudeEntry[] = []
    let bad = 0
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line) as ClaudeEntry)
      } catch {
        bad++
      }
    }
    if (bad) warn(`chat-store/claude: сессия ${id}: пропущено ${bad} битых строк`)
    return out
  }

  function toModel(entries: ClaudeEntry[], id: string): SessionModel {
    const nodes: StoreNode[] = []
    let createdAt: string | undefined
    for (const entry of entries) {
      if (typeof entry.uuid !== 'string') continue // meta-строки без узла дерева
      if (createdAt === undefined && typeof entry.timestamp === 'string') createdAt = entry.timestamp
      nodes.push(entryToNode(entry))
    }
    return { info: { id, createdAt, messageCount: nodes.length }, nodes }
  }

  function entryToNode(entry: ClaudeEntry): StoreNode {
    const role = entry.message?.role ?? (entry.type === 'summary' ? 'system' : entry.type ?? 'system')
    const parts = entry.message ? decodeContent(entry.message.content) : summaryParts(entry)
    const node: StoreNode = { id: entry.uuid!, parent: entry.parentUuid ?? null, role, parts }

    const flags: MessageFlags = {}
    if (entry.isMeta === true) flags.injected = true
    if (Object.keys(flags).length) node.flags = flags

    const meta: Record<string, unknown> = {}
    if (typeof entry.timestamp === 'string') meta.createdAt = entry.timestamp
    if (typeof entry.message?.model === 'string') meta.model = entry.message.model
    if (entry.isSidechain === true) meta.sidechain = true
    if (Object.keys(meta).length) node.meta = meta
    return node
  }

  const store: SessionStore = {
    async capabilities(): Promise<StoreCapabilities> {
      return CAPABILITIES
    },

    async list(): Promise<{ sessions: SessionInfo[] }> {
      const sessions: SessionInfo[] = []
      for (const [id, path] of scan()) {
        try {
          const info = toModel(readEntries(path, id), id).info
          try {
            info.updatedAt = new Date(statSync(path).mtimeMs).toISOString()
          } catch {
            /* файл увели */
          }
          sessions.push(info)
        } catch (err) {
          warn(`chat-store/claude: пропускаю ${path}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      return { sessions }
    },

    async load(id: string): Promise<SessionModel> {
      return toModel(readEntries(pathOf(id), id), id)
    },

    async create(createOpts): Promise<SessionInfo> {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const id = createOpts?.id ?? randomUUID()
      const path = join(dir, `${id}.jsonl`)
      if (existsSync(path)) throw new Error(`chat-store/claude: сессия ${id} уже существует`)
      writeFileSync(path, '', 'utf-8')
      return { id, createdAt: new Date().toISOString(), messageCount: 0 }
    },

    async appendNode(sid: string, node: NodeInput): Promise<StoreNode> {
      const path = pathOf(sid)
      const entries = readEntries(path, sid)
      const lastUuid = lastNodeUuid(entries)
      const parent = node.parent !== undefined ? node.parent : lastUuid

      const uuid = randomUUID()
      // Тип записи claude — только user/assistant; фактическую роль (в т.ч. 'tool',
      // 'system') храним в message.role, чтобы append→load round-trip'ился. Реальные
      // транскрипты несут user/assistant — они декодируются как раньше.
      const type = node.role === 'assistant' ? 'assistant' : 'user'
      const timestamp = new Date().toISOString()
      const entry: ClaudeEntry = {
        parentUuid: parent,
        uuid,
        sessionId: sid,
        type,
        cwd,
        isSidechain: false,
        userType: 'external',
        message: { role: node.role, content: encodeContent(partsOf(node)) },
        timestamp,
      }
      if (node.name !== undefined) (entry as Record<string, unknown>).name = node.name
      appendFileSync(path, JSON.stringify(entry) + '\n', 'utf-8')
      return entryToNode(entry)
    },

    async forkCopy(sid: string, atNodeId?: string): Promise<SessionInfo> {
      const path = pathOf(sid)
      const entries = readEntries(path, sid)
      const byUuid = new Map<string, ClaudeEntry>()
      for (const e of entries) if (typeof e.uuid === 'string') byUuid.set(e.uuid, e)

      const leaf = atNodeId ?? lastNodeUuid(entries)
      if (!leaf) throw new Error(`chat-store/claude: сессия ${sid} пуста — форкать нечего`)
      if (!byUuid.has(leaf)) throw new StoreSessionNotFound(leaf)

      const chain: ClaudeEntry[] = []
      for (let cur: string | null | undefined = leaf; cur; ) {
        const e = byUuid.get(cur)
        if (!e) break
        chain.unshift(e)
        cur = e.parentUuid ?? null
      }

      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const newId = randomUUID()
      const dst = join(dir, `${newId}.jsonl`)
      const lines = chain.map((e) => JSON.stringify({ ...e, sessionId: newId }))
      writeFileSync(dst, lines.length ? lines.join('\n') + '\n' : '', 'utf-8')

      const info: SessionInfo = {
        id: newId,
        createdAt: new Date().toISOString(),
        parentSessionId: sid,
        messageCount: chain.length,
      }
      if (atNodeId) info.forkMessageId = atNodeId
      return info
    },

    async version(sid: string): Promise<string> {
      return createHash('sha256').update(readFileSync(pathOf(sid))).digest('hex').slice(0, 16)
    },
  }

  return store
}

// ── содержимое ──────────────────────────────────────────────────────────────

/** Последний узел дерева (запись с uuid) — активный лист (последняя строка). */
function lastNodeUuid(entries: ClaudeEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (typeof entries[i].uuid === 'string') return entries[i].uuid!
  }
  return null
}

function summaryParts(entry: ClaudeEntry): Part[] {
  const { uuid: _u, parentUuid: _p, timestamp: _t, type, ...body } = entry
  const part: Part = { type: 'custom', data: body, meta: { hint: `claude.${type ?? 'entry'}` } }
  const summary = (body as { summary?: unknown }).summary
  if (typeof summary === 'string') part.text = summary
  return [part]
}

function decodeContent(content: unknown): Part[] {
  if (typeof content === 'string') return content !== '' ? [{ type: 'text', text: content }] : []
  if (!Array.isArray(content)) return []
  const parts: Part[] = []
  for (const raw of content) {
    const block = raw as Record<string, unknown>
    switch (block.type) {
      case 'text': {
        const text = block.text
        if (typeof text === 'string' && text !== '') parts.push({ type: 'text', text })
        break
      }
      case 'thinking': {
        const text = block.thinking
        if (typeof text === 'string' && text !== '') {
          const part: Part = { type: 'thinking', text }
          if (typeof block.signature === 'string') part.meta = { signature: block.signature }
          parts.push(part)
        }
        break
      }
      case 'tool_use':
        parts.push({
          type: 'tool_use',
          data: block.input ?? {},
          meta: { callId: String(block.id ?? ''), name: String(block.name ?? '') },
        })
        break
      case 'tool_result': {
        const part: Part = {
          type: 'tool_result',
          meta: { callId: String(block.tool_use_id ?? ''), error: block.is_error === true },
        }
        const text = toolResultText(block.content)
        if (text !== undefined) part.text = text
        parts.push(part)
        break
      }
      case 'image': {
        const src = block.source as { media_type?: string; data?: string } | undefined
        const meta: { mime?: string; url?: string } = {}
        if (src?.media_type) meta.mime = src.media_type
        if (src?.data) meta.url = `data:${src.media_type ?? 'application/octet-stream'};base64,${src.data}`
        parts.push({ type: 'image', meta })
        break
      }
      default:
        parts.push({ type: 'custom', data: block, meta: { hint: `claude.block.${String(block.type)}` } })
    }
  }
  return parts
}

function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
    .map((b) => b.text)
  return texts.length ? texts.join('') : undefined
}

function encodeContent(parts: Part[]): unknown[] {
  const out: unknown[] = []
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        out.push({ type: 'text', text: part.text })
        break
      case 'thinking': {
        const block: Record<string, unknown> = { type: 'thinking', thinking: part.text }
        if (part.meta?.signature) block.signature = part.meta.signature
        out.push(block)
        break
      }
      case 'tool_use':
        out.push({ type: 'tool_use', id: part.meta.callId, name: part.meta.name, input: part.data ?? {} })
        break
      case 'tool_result':
        out.push({
          type: 'tool_result',
          tool_use_id: part.meta.callId,
          content: part.text ?? '',
          is_error: part.meta.error === true,
        })
        break
      case 'image': {
        const url = part.meta.url ?? ''
        const m = /^data:([^;,]*);base64,(.*)$/s.exec(url)
        if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } })
        break
      }
      case 'custom':
        if (part.data && typeof part.data === 'object') out.push(part.data)
        break
    }
  }
  return out
}
