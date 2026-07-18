/**
 * pi-записи ⇄ нейтральная модель (spec §7.2).
 *
 * `toModel` проецирует ВСЁ дерево (каждая запись → узел) — модель хранилища
 * несёт полный append-порядок, срез (активный путь/тред) считают проекции ядра.
 * Отличие от backend-pi (который отдавал уже активный путь): там был протокол-
 * бэкенд, здесь — слой хранения ниже протокола.
 */

import type {
  MessageFlags,
  Part,
  SessionModel,
  StoreNode,
} from '../model.js'
import {
  HIDDEN_CUSTOM_TYPE,
  type PiAgentMessage,
  type PiAssistantMessage,
  type PiContentBlock,
  type PiEntry,
  type PiMessageEntry,
  type PiSessionFile,
  type PiToolResultMessage,
  type PiUsage,
} from './format.js'

const ROLE_MAP: Record<string, string> = { user: 'user', assistant: 'assistant', toolResult: 'tool' }

/** Роль протокола → роль pi. */
export function toPiRole(role: string): string {
  return role === 'tool' ? 'toolResult' : role
}

// ── decode: file → model ──────────────────────────────────────────────────────

export function toModel(file: PiSessionFile, sid: string): SessionModel {
  const nodes = file.entries.map(entryToNode)
  return {
    info: { id: sid, createdAt: file.header.timestamp, messageCount: nodes.length },
    nodes,
  }
}

function entryToNode(entry: PiEntry): StoreNode {
  const parent = entry.parentId ?? null

  if (entry.type === 'message') {
    return messageNode(entry.id, parent, (entry as PiMessageEntry).message, undefined, entry.timestamp)
  }

  const custom = entry as { customType?: string; data?: { message?: PiAgentMessage } }
  if (entry.type === 'custom' && custom.customType === HIDDEN_CUSTOM_TYPE) {
    const inner = custom.data?.message
    if (inner && typeof inner === 'object') {
      return messageNode(entry.id, parent, inner, { hidden: true }, entry.timestamp)
    }
  }

  // Прочие записи (model_change/session_info/compaction/…) — узлы дерева со
  // своим id/parentId. Проносим custom part'ом с hint `pi.<type>` (§2.3).
  const { id, parentId, timestamp, type, ...body } = entry as PiEntry & Record<string, unknown>
  const part: Part = { type: 'custom', data: body, meta: { hint: `pi.${type}` } }
  const summary = (body as { summary?: unknown }).summary
  const content = (body as { content?: unknown }).content
  if (typeof summary === 'string') part.text = summary
  else if (typeof content === 'string') part.text = content

  const node: StoreNode = { id: String(id), parent, role: 'system', parts: [part] }
  if (typeof timestamp === 'string') node.meta = { createdAt: timestamp }
  return node
}

function messageNode(
  id: string,
  parent: string | null,
  message: PiAgentMessage,
  flags: MessageFlags | undefined,
  timestamp: string,
): StoreNode {
  const role = ROLE_MAP[message.role] ?? message.role
  const node: StoreNode = { id, parent, role, parts: decodeParts(message) }
  if (flags) node.flags = flags

  const meta: Record<string, unknown> = {}
  if (typeof timestamp === 'string') meta.createdAt = timestamp
  if (message.role === 'assistant') {
    const m = message as PiAssistantMessage
    if (m.model !== undefined) meta.model = m.model
    const usage = decodeUsage(m.usage)
    if (usage) meta.usage = usage
  }
  if (Object.keys(meta).length) node.meta = meta
  return node
}

function decodeUsage(usage: PiUsage | undefined): { input: number; output: number } | undefined {
  if (!usage) return undefined
  const { input, output } = usage
  if (typeof input !== 'number' || typeof output !== 'number') return undefined
  return { input, output }
}

function decodeParts(message: PiAgentMessage): Part[] {
  if (message.role === 'toolResult') return decodeToolResult(message as PiToolResultMessage)
  const parts: Part[] = []
  for (const block of contentBlocks(message.content)) {
    const part = decodeBlock(block)
    if (part) parts.push(part)
  }
  if (message.role === 'assistant') {
    const m = message as PiAssistantMessage
    if (typeof m.errorMessage === 'string' && m.errorMessage !== '') {
      parts.push({ type: 'error', text: m.errorMessage, meta: { code: m.stopReason ?? 'error' } })
    }
  }
  return parts
}

function decodeToolResult(message: PiToolResultMessage): Part[] {
  const texts: string[] = []
  const extra: Part[] = []
  for (const block of contentBlocks(message.content)) {
    if (block.type === 'text' && typeof (block as { text?: string }).text === 'string') {
      texts.push((block as { text: string }).text)
    } else {
      const part = decodeBlock(block)
      if (part) extra.push(part)
    }
  }
  const part: Part = {
    type: 'tool_result',
    meta: { callId: message.toolCallId ?? '', name: message.toolName, error: message.isError === true },
  }
  if (texts.length) part.text = texts.join('')
  if (message.details !== undefined) part.data = message.details
  return [part, ...extra]
}

function decodeBlock(block: PiContentBlock): Part | null {
  switch (block.type) {
    case 'text': {
      const text = (block as { text?: string }).text
      return typeof text === 'string' && text !== '' ? { type: 'text', text } : null
    }
    case 'thinking': {
      const b = block as { thinking?: string; thinkingSignature?: string }
      if (typeof b.thinking !== 'string' || b.thinking === '') return null
      const part: Part = { type: 'thinking', text: b.thinking }
      if (b.thinkingSignature !== undefined) part.meta = { signature: b.thinkingSignature }
      return part
    }
    case 'toolCall': {
      const b = block as { id?: string; name?: string; arguments?: unknown }
      return { type: 'tool_use', data: b.arguments ?? {}, meta: { callId: b.id ?? '', name: b.name ?? '' } }
    }
    case 'image': {
      const b = block as { data?: string; mimeType?: string }
      const meta: { mime?: string; url?: string } = {}
      if (b.mimeType !== undefined) meta.mime = b.mimeType
      if (b.data !== undefined) meta.url = `data:${b.mimeType ?? 'application/octet-stream'};base64,${b.data}`
      return { type: 'image', meta }
    }
    default:
      return { type: 'custom', data: block, meta: { hint: `pi.block.${block.type}` } }
  }
}

function contentBlocks(content: PiAgentMessage['content']): PiContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (Array.isArray(content)) return content as PiContentBlock[]
  return []
}

// ── encode: parts → pi message ────────────────────────────────────────────────

/**
 * Части протокола → сообщение pi. Подписи НЕ переносятся (правленый контент со
 * старой подписью — ошибка провайдера): `textSignature`/`thinkingSignature`/
 * `thoughtSignature` опускаются.
 */
export function partsToMessage(role: string, name: string | undefined, parts: Part[]): PiAgentMessage {
  const piRole = toPiRole(role)

  if (piRole === 'toolResult') {
    const tr = parts.find((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result')
    const text = parts
      .filter((p): p is Extract<Part, { type: 'tool_result' }> => p.type === 'tool_result')
      .map((p) => p.text ?? '')
      .join('')
    return {
      role: 'toolResult',
      toolCallId: tr?.meta.callId ?? '',
      toolName: tr?.meta.name ?? '',
      content: [{ type: 'text', text }],
      isError: tr?.meta.error === true,
    } as PiToolResultMessage
  }

  const blocks: PiContentBlock[] = []
  for (const part of parts) {
    const block = partToBlock(part)
    if (block) blocks.push(block)
  }
  const message: PiAgentMessage = { role: piRole, content: blocks } as PiAgentMessage
  if (name !== undefined) (message as Record<string, unknown>).name = name
  return message
}

function partToBlock(part: Part): PiContentBlock | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'thinking':
      return { type: 'thinking', thinking: part.text }
    case 'tool_use':
      return {
        type: 'toolCall',
        id: part.meta.callId,
        name: part.meta.name,
        arguments: (part.data ?? {}) as Record<string, unknown>,
      }
    case 'image': {
      const url = part.meta.url ?? ''
      const m = /^data:([^;,]*);base64,(.*)$/s.exec(url)
      if (m) return { type: 'image', data: m[2], mimeType: m[1] }
      return null
    }
    case 'custom': {
      const data = part.data
      if (data && typeof data === 'object' && typeof (data as { type?: unknown }).type === 'string') {
        return data as PiContentBlock
      }
      return null
    }
    default:
      return null
  }
}

/** Заменить контент message-записи новыми частями (сброс подписей/ошибки). */
export function applyParts(entry: PiMessageEntry, parts: Part[]): PiMessageEntry {
  const message = partsToMessage(entry.message.role, undefined, parts)
  // Сохраняем не-контентные поля исходного сообщения (usage/responseId/model…).
  const merged: PiAgentMessage = { ...entry.message, ...message } as PiAgentMessage
  if (entry.message.role === 'assistant') {
    const m = merged as PiAssistantMessage
    if (m.stopReason === 'error') m.stopReason = 'stop'
    delete m.errorMessage
  }
  return { ...entry, message: merged }
}
