/**
 * pi session JSONL v3 — схема формата + чтение/запись файла + идентификаторы.
 *
 * Выделение codec из backend-pi (spec §7.2, backends-spec §4.1): второй
 * потребитель наступил — это драйвер. Схема — локальная копия pi (а не импорт):
 * кодек обязан читать файлы pi, но тащить пакет pi ради интерфейсов — нет.
 * Дрейф апстрима ловится smoke-тестом на `pinVersion`, а не молчаливой поломкой.
 *
 * Сверено с pi 0.80.6.
 */

import { randomUUID } from 'node:crypto'

// ── контент-блоки ─────────────────────────────────────────────────────────────

export interface PiTextContent {
  type: 'text'
  text: string
  textSignature?: string
}
export interface PiThinkingContent {
  type: 'thinking'
  thinking: string
  thinkingSignature?: string
  redacted?: boolean
}
export interface PiImageContent {
  type: 'image'
  data: string // base64
  mimeType: string
}
export interface PiToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
  thoughtSignature?: string
}
export type PiContentBlock =
  | PiTextContent
  | PiThinkingContent
  | PiImageContent
  | PiToolCall
  | { type: string; [k: string]: unknown }

export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  [k: string]: unknown
}

// ── сообщения ─────────────────────────────────────────────────────────────────

export type PiMessageTimestamp = number | string

export interface PiUserMessage {
  role: 'user'
  content: string | (PiTextContent | PiImageContent)[]
  timestamp?: PiMessageTimestamp
  [k: string]: unknown
}
export interface PiAssistantMessage {
  role: 'assistant'
  content: (PiTextContent | PiThinkingContent | PiToolCall)[]
  model?: string
  usage?: PiUsage
  stopReason?: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
  errorMessage?: string
  timestamp?: PiMessageTimestamp
  [k: string]: unknown
}
export interface PiToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (PiTextContent | PiImageContent)[]
  details?: unknown
  isError: boolean
  timestamp?: PiMessageTimestamp
  [k: string]: unknown
}
export interface PiOtherMessage {
  role: string
  content?: string | PiContentBlock[]
  timestamp?: PiMessageTimestamp
  [k: string]: unknown
}
export type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiOtherMessage

// ── записи файла ──────────────────────────────────────────────────────────────

export interface PiSessionHeader {
  type: 'session'
  version?: number
  id: string
  timestamp: string
  cwd: string
  parentSession?: string
}
export interface PiEntryBase {
  type: string
  id: string
  parentId: string | null
  timestamp: string
}
export interface PiMessageEntry extends PiEntryBase {
  type: 'message'
  message: PiAgentMessage
}
/** Запись любого другого типа — проносится дословно (forward-compat). */
export interface PiUnknownEntry extends PiEntryBase {
  [k: string]: unknown
}
export type PiEntry = PiMessageEntry | PiUnknownEntry
export type PiFileEntry = PiSessionHeader | PiEntry

/** Версия формата, которую пишет и понимает кодек. */
export const PI_SESSION_VERSION = 3

/**
 * customType скрытого сообщения — общее с pims/backend-pi: pi хранит `custom`,
 * но НЕ кладёт в контекст LLM, т.е. ровно `flags.hidden` («видно в UI, невидимо
 * LLM»).
 */
export const HIDDEN_CUSTOM_TYPE = 'mds-hidden'

export function isPiHeader(e: PiFileEntry): e is PiSessionHeader {
  return e.type === 'session'
}
export function isPiMessageEntry(e: PiFileEntry): e is PiMessageEntry {
  return e.type === 'message'
}

// ── файл ──────────────────────────────────────────────────────────────────────

export interface PiSessionFile {
  header: PiSessionHeader
  entries: PiEntry[]
}

export class PiCodecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiCodecError'
  }
}

/**
 * Текст JSONL → сессия. Толерантно, как pi: пустые/битые строки скипаются,
 * обязателен только валидный header.
 */
export function parseSessionFile(text: string): PiSessionFile {
  const entries: PiEntry[] = []
  let header: PiSessionHeader | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      continue
    }
    if (!isFileEntry(value)) continue
    if (isPiHeader(value)) {
      if (!header && typeof value.id === 'string') header = value
      continue
    }
    if (typeof value.id !== 'string' || !('parentId' in value)) continue
    entries.push(value)
  }
  if (!header) throw new PiCodecError('файл не является сессией pi: нет header {type:"session", id}')
  return { header, entries }
}

/** Сессия → текст JSONL. Порядок ключей сохраняется как есть (pi парсит по ключам). */
export function serializeSessionFile(file: PiSessionFile): string {
  const lines = [JSON.stringify(file.header), ...file.entries.map((e) => JSON.stringify(e))]
  return `${lines.join('\n')}\n`
}

export function newSessionHeader(id: string, cwd: string, timestamp: string): PiSessionHeader {
  return { type: 'session', version: PI_SESSION_VERSION, id, timestamp, cwd }
}

/** Имя файла сессии по правилу pi: `${ISO с : и . → -}_${id}.jsonl`. */
export function sessionFileName(sessionId: string, timestamp: string): string {
  return `${timestamp.replace(/[:.]/g, '-')}_${sessionId}.jsonl`
}

function isFileEntry(value: unknown): value is PiFileEntry {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

// ── идентификаторы ────────────────────────────────────────────────────────────

/** uuidv7: 48-бит времени (BE) + случайный хвост. pi ищет сессии по id. */
export function uuidv7(ms: number): string {
  const bytes = new Uint8Array(16)
  const time = BigInt(Math.floor(ms))
  for (let i = 0; i < 6; i++) bytes[i] = Number((time >> BigInt(8 * (5 - i))) & 0xffn)
  const rnd = randomUUID().replace(/-/g, '')
  for (let i = 6; i < 16; i++) bytes[i] = parseInt(rnd.slice((i - 6) * 2, (i - 6) * 2 + 2), 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** id записи: 8 hex-символов, уникальный в файле. */
export function entryId(taken: ReadonlySet<string>): string {
  for (let i = 0; i < 100; i++) {
    const id = randomUUID().slice(0, 8)
    if (!taken.has(id)) return id
  }
  throw new Error('chat-store/pi: не удалось выдать уникальный id записи')
}
