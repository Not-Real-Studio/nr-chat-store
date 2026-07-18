/**
 * nr-chat codec — session → message-anatomy projection (§5).
 *
 * `%meta` → `SessionInfo`; `%%` sub-nodes of the header → `sessionMeta`. The
 * message projection itself is core math: `toProtocol` unfolds the session to a
 * `SessionModel` (`project`/`toModel`) and hands it to the core `toHistory`
 * (active path + swipes + content hash) — no tree math lives here.
 */

import type { Message, SessionInfo } from '../model.js'
import { toHistory } from '../tree.js'
import type { Session, SessionHeader } from './session.js'
import { toModel } from './project.js'
import { decodeSubBody, type PartDecoders } from './parts.js'

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
] as const

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
  const out: Record<string, unknown> = {}
  for (const sub of session.header?.subNodes ?? []) out[sub.kind] = decodeSubBody(sub, decoders)
  return out
}
