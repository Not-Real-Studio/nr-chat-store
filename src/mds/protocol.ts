/**
 * mds-кодек — проекция сессии в анатомию сообщения (слито из nr-session, §5).
 *
 * Обычная нода + её суб-ноды → `Message`. `%meta` → `SessionInfo`. `history()`
 * = активный путь; `swipes` — derived из siblings. Типы модели — из дома
 * анатомии (`../model.js`); протокол ре-экспортирует их же (chat-store-spec §1).
 */

import type { Message, MessageFlags, MessageMeta, SessionInfo, Usage } from '../model.js'
import type { Session, SessionHeader, SessionNode } from './session.js'
import { activePath, resolveTree, swipeInfo, type Tree } from './tree.js'
import { assembleParts, decodeSubBody, type PartDecoders } from './parts.js'

function bool(v: unknown): boolean | undefined {
  return v === true ? true : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Флаги сообщения из меты ноды — словарь модели как есть (§5). */
function flagsOf(meta: Record<string, unknown> | undefined): MessageFlags | undefined {
  if (!meta) return undefined
  const flags: MessageFlags = {}
  if (bool(meta.hidden)) flags.hidden = true
  if (bool(meta.frozen)) flags.frozen = true
  if (bool(meta.injected)) flags.injected = true
  return Object.keys(flags).length ? flags : undefined
}

/** `model`, `usage`, `createdAt` из меты ноды → `Message.meta` (§5). */
function metaOf(meta: Record<string, unknown> | undefined): MessageMeta | undefined {
  if (!meta) return undefined
  const out: MessageMeta = {}
  const createdAt = str(meta.createdAt)
  const model = str(meta.model)
  if (createdAt !== undefined) out.createdAt = createdAt
  if (model !== undefined) out.model = model
  if (meta.usage && typeof meta.usage === 'object') out.usage = meta.usage as Usage
  return Object.keys(out).length ? out : undefined
}

/** Обычная нода → `Message`. `id`: явный либо позиционный `pos:N` (§5). */
export function nodeToMessage(node: SessionNode, tree: Tree, decoders?: PartDecoders): Message {
  const message: Message = {
    id: node.id ?? `pos:${node.index}`,
    role: node.role,
    parts: assembleParts(node, decoders),
  }
  if (node.name !== undefined) message.name = node.name

  const flags = flagsOf(node.meta)
  if (flags) message.flags = flags

  const meta = metaOf(node.meta)
  if (meta) message.meta = meta

  // Свайпы — только там, где веток больше одной (§3).
  const info = swipeInfo(node, tree)
  if (info.count > 1) message.swipes = { active: info.active, count: info.count }

  return message
}

/** Известные поля SessionInfo, вычитываемые из `%meta` (§5). Прочее — не теряется в модели. */
const SESSION_INFO_STRINGS = [
  'title',
  'createdAt',
  'updatedAt',
  'botId',
  'botName',
  'botAvatar',
  'accentColor',
  'parentSessionId',
  'forkMessageId',
] as const

/** `%meta` → `SessionInfo` (§5). Без хедера — минимальный info с пустым id. */
export function headerToSessionInfo(header: SessionHeader | undefined, messageCount: number): SessionInfo {
  const info: SessionInfo = { id: header?.id ?? '' }
  const meta = header?.meta
  if (meta) {
    for (const key of SESSION_INFO_STRINGS) {
      const v = str(meta[key])
      if (v !== undefined) (info as unknown as Record<string, unknown>)[key] = v
    }
    if (Array.isArray(meta.participants)) info.participants = meta.participants as SessionInfo['participants']
  }
  info.messageCount = messageCount
  return info
}

/**
 * Проекция сессии в анатомию: `SessionInfo` + `Message[]` активного пути (§5).
 * `history()` = активный путь, поэтому messages идут от корня к листу.
 */
export function toProtocol(
  session: Session,
  opts?: { decoders?: PartDecoders },
): { session: SessionInfo; messages: Message[] } {
  const tree = resolveTree(session.nodes)
  const path = activePath(session, tree)
  const messages = path.map((node) => nodeToMessage(node, tree, opts?.decoders))
  return { session: headerToSessionInfo(session.header, messages.length), messages }
}

/**
 * sessionMeta из `%%`-суб-нод хедера (§2): имя суб-роли = ключ, значение —
 * body, декодированное по `format` (§4; без format — сырой текст). Отдаётся
 * операцией `sessions.meta.get` протокола (capability `sessionMeta`).
 */
export function sessionMetaOf(session: Session, decoders?: PartDecoders): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const sub of session.header?.subNodes ?? []) out[sub.kind] = decodeSubBody(sub, decoders)
  return out
}
