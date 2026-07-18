/**
 * mds-кодек — словарь суб-нод ↔ Part модели (слито из nr-session, §4).
 *
 * Один уровень `%%`-суб-нод, плоский состав как `Part[]` модели. Известная
 * роль → соответствующий Part; неизвестная `%%роль` → `custom` с `hint = роль`
 * (graceful degradation, зеркало протокола §1.2). Тело родителя = первый
 * text-part (§4).
 *
 * `Part` — из дома анатомии сообщения (`../model.js`); протокол ре-экспортирует
 * его же, тип идентичен (инверсия chat-store-spec §1).
 */

import { parseJson5, stringifyJson5 } from '@notrealstudio/nr-chat'
import type { ChatMessage } from '@notrealstudio/nr-chat'
import type { Part } from '../model.js'
import type { SessionNode, SubNode } from './session.js'

function metaStr(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = meta?.[key]
  return typeof v === 'string' ? v : undefined
}

/** Кодеки body по `format` (§4/§6): инъекция потребителем, либа кодеки не тянет. */
export type PartDecoders = Record<string, (body: string) => unknown>

/**
 * Декод body по `format` (§4): `json5` бесплатен (nr-chat), инъектированный
 * декодер — если передан; неизвестный/непереданный формат → сырая строка,
 * не ошибка. `json5Default` — дефолт роли при отсутствии format (tool_use).
 */
function decodeBody(
  body: string,
  format: string | undefined,
  decoders: PartDecoders | undefined,
  json5Default = false,
): unknown {
  if (format === undefined) return json5Default ? parseData(body) : body
  if (format === 'json5') return parseData(body)
  const dec = decoders?.[format]
  if (dec) {
    try {
      return dec(body)
    } catch {
      return body
    }
  }
  return body
}

/** Декод body суб-ноды по её `format` (для sessionMeta хедера, §2). */
export function decodeSubBody(sub: SubNode, decoders?: PartDecoders): unknown {
  return decodeBody(sub.body, typeof sub.meta?.format === 'string' ? sub.meta.format : undefined, decoders)
}

/** JSON5-тело суб-ноды → данные. Пустое/битое тело деградирует в сырой текст. */
function parseData(body: string): unknown {
  const trimmed = body.trim()
  if (trimmed === '') return undefined
  try {
    return parseJson5(trimmed)
  } catch {
    return body
  }
}

/**
 * Суб-нода → Part по словарю ядра (§4). Неизвестная роль → `custom` с
 * `hint = kind`.
 */
export function subNodeToPart(sub: SubNode, decoders?: PartDecoders): Part {
  const meta = sub.meta
  switch (sub.kind) {
    case 'text':
      return { type: 'text', text: sub.body }

    case 'thinking': {
      const signature = metaStr(meta, 'signature')
      return signature !== undefined
        ? { type: 'thinking', text: sub.body, meta: { signature } }
        : { type: 'thinking', text: sub.body }
    }

    case 'tool_use':
      return {
        type: 'tool_use',
        data: decodeBody(sub.body, metaStr(meta, 'format'), decoders, true),
        meta: { callId: metaStr(meta, 'callId') ?? '', name: metaStr(meta, 'name') ?? '' },
      }

    case 'tool_result': {
      const m: { callId: string; name?: string; error?: boolean } = {
        callId: metaStr(meta, 'callId') ?? '',
      }
      const name = metaStr(meta, 'name')
      if (name !== undefined) m.name = name
      if (meta?.error === true) m.error = true
      const fmt = metaStr(meta, 'format')
      if (fmt !== undefined)
        return { type: 'tool_result', data: decodeBody(sub.body, fmt, decoders), text: sub.body, meta: m }
      return { type: 'tool_result', text: sub.body, meta: m }
    }

    case 'attach': {
      // Различие file/image — по mime (§4). name-поле маркера = display name,
      // `file:` ref → meta.ref. Извлечённый текст (тело) остаётся в модели
      // сессии (для контекста LLM); в UI-DTO file/image несут только мету.
      const mime = metaStr(meta, 'mime')
      const ref = metaStr(meta, 'file')
      if (mime && mime.startsWith('image/')) {
        const m: { mime?: string; ref?: string; alt?: string } = {}
        if (mime) m.mime = mime
        if (ref) m.ref = ref
        if (sub.name) m.alt = sub.name
        return { type: 'image', meta: m }
      }
      const m: { name: string; mime?: string; ref?: string } = { name: sub.name ?? '' }
      if (mime) m.mime = mime
      if (ref) m.ref = ref
      return { type: 'file', meta: m }
    }

    case 'error': {
      const code = metaStr(meta, 'code')
      return code !== undefined
        ? { type: 'error', text: sub.body, meta: { code } }
        : { type: 'error', text: sub.body }
    }

    case 'custom': {
      const fmt = metaStr(meta, 'format')
      const out: Part = {
        type: 'custom',
        text: sub.body,
        meta: { hint: metaStr(meta, 'hint') ?? 'custom', ...(meta ?? {}) },
      }
      if (fmt !== undefined) (out as { data?: unknown }).data = decodeBody(sub.body, fmt, decoders)
      return out
    }

    default:
      // Неизвестная %%роль → custom, hint = роль (§4).
      return { type: 'custom', text: sub.body, meta: { hint: sub.kind, ...(meta ?? {}) } }
  }
}

/**
 * Собрать `parts` обычной ноды: тело = первый text-part (если непустое либо
 * суб-нод нет — иначе ведущего текста просто нет), далее суб-ноды по словарю.
 */
export function assembleParts(node: SessionNode, decoders?: PartDecoders): Part[] {
  const parts: Part[] = []
  if (node.body !== '' || node.subNodes.length === 0) {
    parts.push({ type: 'text', text: node.body })
  }
  for (const sub of node.subNodes) parts.push(subNodeToPart(sub, decoders))
  return parts
}

/** Роль суб-ноды по типу Part (обратная сторона словаря, для сериализации). */
const PART_TYPE_TO_ROLE: Record<string, string> = {
  text: '%text',
  thinking: '%thinking',
  tool_use: '%tool_use',
  tool_result: '%tool_result',
  file: '%attach',
  image: '%attach',
  error: '%error',
  custom: '%custom',
}

/**
 * Part → суб-нода (ChatMessage с `%`-ролью) для записи в mds. Обратная сторона
 * словаря §4: используется мутациями при сборке нового сообщения.
 *
 * Заметь: `file`/`image` в протоколе несут только мету, извлечённого текста в
 * DTO нет — тело суб-ноды `%%attach` пустое (сайдкар-текст добавляет бэкенд).
 */
export function partToSubMessage(part: Part): ChatMessage {
  const role = PART_TYPE_TO_ROLE[part.type] ?? '%' + part.type

  switch (part.type) {
    case 'text':
      return { role, body: part.text }

    case 'thinking': {
      const meta = part.meta?.signature !== undefined ? { signature: part.meta.signature } : undefined
      return { role, body: part.text, meta }
    }

    case 'tool_use': {
      const body = typeof part.data === 'string' ? part.data : stringifyJson5(part.data ?? {})
      return { role, body, meta: { callId: part.meta.callId, name: part.meta.name } }
    }

    case 'tool_result': {
      const meta: Record<string, unknown> = { callId: part.meta.callId }
      if (part.meta.name !== undefined) meta.name = part.meta.name
      if (part.meta.error) meta.error = true
      const body = part.text ?? (part.data !== undefined ? stringifyJson5(part.data) : '')
      return { role, body, meta }
    }

    case 'file': {
      const meta: Record<string, unknown> = {}
      if (part.meta.ref) meta.file = part.meta.ref
      if (part.meta.mime) meta.mime = part.meta.mime
      return { role, name: part.meta.name, body: '', meta: Object.keys(meta).length ? meta : undefined }
    }

    case 'image': {
      const meta: Record<string, unknown> = {}
      if (part.meta.ref) meta.file = part.meta.ref
      if (part.meta.mime) meta.mime = part.meta.mime
      return { role, name: part.meta.alt, body: '', meta: Object.keys(meta).length ? meta : undefined }
    }

    case 'error':
      return { role, body: part.text, meta: part.meta?.code !== undefined ? { code: part.meta.code } : undefined }

    case 'custom': {
      const body = part.text ?? (part.data !== undefined ? stringifyJson5(part.data) : '')
      return { role, body, meta: part.meta }
    }
  }
}
