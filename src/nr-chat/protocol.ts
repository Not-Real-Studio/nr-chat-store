/**
 * nr-chat codec — session → message-anatomy projection (§5).
 *
 * `%meta` → `SessionInfo`; `%%` sub-nodes of the header → `sessionMeta`. The
 * message projection itself is core math: `toProtocol` unfolds the session to a
 * `SessionModel` (`project`/`toModel`) and hands it to the core `toHistory`
 * (active path + swipes + content hash) — no tree math lives here.
 */

import type { Message, SessionInfo, SessionShare, SessionTask } from '../model.js'
import { toHistory } from '../tree.js'
import type { Session, SessionHeader } from './session.js'
import { toModel } from './project.js'
import type { PartDecoders } from './parts.js'
import { botOf, headerSessionMeta } from './header.js'

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Known SessionInfo fields read from `%meta` (§5). Everything else is preserved in the model. */
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
  // Проект сессии (projects-spec §2, DEV-287): id реестра стенда; нет — `default`.
  'workspace',
  // Проект-репа сессии (spaces-spec §3, DEV-319): id из `workspace.repos`; нет — без проекта.
  'project',
] as const

/** `sessionMeta.shared` → `SessionShare`; пусто или чужая форма — `undefined`. */
export function shareOf(v: unknown): SessionShare | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const users = Array.isArray(o.users) ? o.users.filter((u): u is string => typeof u === 'string' && u !== '') : []
  const out: SessionShare = {}
  if (o.project === true) out.project = true
  if (users.length) out.users = users
  if (!out.project && !out.users) return undefined
  if (o.write === true) out.write = true
  return out
}

/** `sessionMeta.task` → `SessionTask`; чужая форма — `undefined`. */
export function taskOf(v: unknown): SessionTask | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  if (typeof o.issue !== 'string' || !o.issue || (o.role !== 'executor' && o.role !== 'acceptor')) return undefined
  return { issue: o.issue, role: o.role, ...(typeof o.parent === 'string' && o.parent ? { parent: o.parent } : {}) }
}

/** `%meta` → `SessionInfo` (§5). No header → a minimal info with an empty id. */
export function headerToSessionInfo(header: SessionHeader | undefined, messageCount: number): SessionInfo {
  const info: SessionInfo = { id: header?.id ?? '' }
  const meta = header?.meta
  if (meta) {
    for (const key of SESSION_INFO_STRINGS) {
      const v = str(meta[key])
      if (v !== undefined) (info as unknown as Record<string, unknown>)[key] = v
    }
    if (Array.isArray(meta.participants)) info.participants = meta.participants as SessionInfo['participants']
    // Автор и «поделиться» (users-spec §4): пишет хаб в мету сессии (`meta.patch`).
    const sm = meta.sessionMeta
    if (sm && typeof sm === 'object' && !Array.isArray(sm)) {
      const owner = str((sm as Record<string, unknown>).owner)
      if (owner !== undefined) info.owner = owner
      const shared = shareOf((sm as Record<string, unknown>).shared)
      if (shared) info.shared = shared
      // Задача (task-session-spec §8): пишет хост задач патчем меты.
      const task = taskOf((sm as Record<string, unknown>).task)
      if (task) info.task = task
    }
    // Персоны подузлами (DEV-243): бот — из первой char-персоны.
    const bot = botOf(header)
    if (info.botName === undefined && bot.botName !== undefined) info.botName = bot.botName
    if (info.botAvatar === undefined && bot.botAvatar !== undefined) info.botAvatar = bot.botAvatar
  }
  info.messageCount = messageCount
  return info
}

/**
 * Project a session to message anatomy: `SessionInfo` + `Message[]` of the
 * active path (§5). `history()` is the active path, so messages run root → leaf.
 */
export function toProtocol(
  session: Session,
  opts?: { decoders?: PartDecoders },
): { session: SessionInfo; messages: Message[] } {
  const model = toModel(session, opts?.decoders)
  return { session: model.info, messages: toHistory(model) }
}

/**
 * sessionMeta from the header's `%%` sub-nodes (§2): the sub-role name is the
 * key, the value is the body decoded by its `format` (§4; no format → raw text).
 * Served by the protocol's `sessions.meta.get` (capability `sessionMeta`).
 */
export function sessionMetaOf(session: Session, decoders?: PartDecoders): Record<string, unknown> {
  // Персоны (`%%character`) и inline-профиль (`%%profile`) — не мета сессии (DEV-243).
  return headerSessionMeta(session.header, { decoders })
}
