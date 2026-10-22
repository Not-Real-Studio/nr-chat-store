/**
 * Вид чата и происхождение имени (DEV-428, протокол v1.44).
 *
 * Вид (`SessionInfo.kind`) — кто и зачем говорит в сессии: разговор с Денисом
 * (`talk`, сюда же миты), исполнитель/приёмщик задачи (`run`/`review`), пробы и
 * тесты (`probe`), ролевая игра (`rp`), автопрогоны без человека (`auto`).
 * Явный `sessionMeta.kind` главнее; без него вид выводится дёшево, без модели —
 * {@link sessionKindOf}. Список сайдбара и карточки чатов смотрят только на него.
 *
 * Происхождение имени (`SessionInfo.titleSource`, `sessionMeta.titleSource`):
 * `user` — переименовал человек, `create` — заголовок при создании (мит по крону,
 * задача), `agent` — заголовок от агента (`session_info_update` CC), `auto` —
 * первые 40 символов первой реплики или имя из карточки. `user` и `create`
 * автоматически не переписываются никогда.
 */

import type { SessionTask } from './model.js'

export type SessionKind = 'talk' | 'run' | 'review' | 'probe' | 'rp' | 'auto'
export type TitleSource = 'user' | 'create' | 'agent' | 'auto'

export const SESSION_KINDS: readonly SessionKind[] = ['talk', 'run', 'review', 'probe', 'rp', 'auto']
export const TITLE_SOURCES: readonly TitleSource[] = ['user', 'create', 'agent', 'auto']

export function isSessionKind(v: unknown): v is SessionKind {
  return typeof v === 'string' && (SESSION_KINDS as readonly string[]).includes(v)
}

export function isTitleSource(v: unknown): v is TitleSource {
  return typeof v === 'string' && (TITLE_SOURCES as readonly string[]).includes(v)
}

/** Имя защищено от автоматики: его дал человек или создатель сессии. */
export function isProtectedTitle(source: TitleSource | undefined): boolean {
  return source === 'user' || source === 'create'
}

/** Автоимя бэкенда: 40 символов первой реплики + «…» (`autoTitle` backend-http). */
export function isAutoTitle(title: string | undefined): boolean {
  if (!title || !title.endsWith('…')) return false
  return [...title].length === 41
}

/** Профили автопрогонов без человека (slot-step, порт trempel, раскопки слотов). */
export const AUTO_PROFILES: readonly string[] = ['slot-step', 'slot-research', 'trempel-port']

/** Что вид знает о сессии: всё дёшево, из шапки. */
export interface KindInput {
  /** Явный `sessionMeta.kind` — главнее любых правил. */
  kind?: unknown
  title?: string
  task?: SessionTask
  /** Пространство (`SessionInfo.workspace`); нет — `default`. */
  workspace?: string
  /** Профиль/агент сессии (nr — `%meta profile`, ACP — профиль связи). */
  profile?: string
  /** Контур, создавший сессию (`sessionMeta.contour`). */
  contour?: string
  /** В сессии есть персона-бот (`%%character {kind: 'char'}`) или персона игрока. */
  persona?: boolean
}

const TASK_TITLE = /^[A-Z][A-Z0-9]*-\d+ · (исполнитель|приёмщик)/
const TASK_HEADING = /^#\s*[A-Z][A-Z0-9]*-\d+:/
const PROBE_TITLE = /^qa[-_\s]/i
const AUTO_TITLE = /^(nr-code|trempel-port|slot-step)[:\s]/

/**
 * Вид сессии без модели. Порядок: явный → задача (мета DEV-330, для старых —
 * заголовок `KEY-N · исполнитель/приёмщик`) → проба (`qa-`, контур lab, пустое
 * пространство на dev — приёмки e2e) → автопрогон (профиль/заголовок) → RP
 * (пространство или профиль `rp`, персона в сессии) → разговор. Число реплик
 * не критерий: короткий настоящий разговор не прячется.
 */
export function sessionKindOf(i: KindInput): SessionKind {
  if (isSessionKind(i.kind)) return i.kind
  if (i.task) return i.task.role === 'acceptor' ? 'review' : 'run'
  const title = (i.title ?? '').trim()
  const t = TASK_TITLE.exec(title)
  if (t) return t[1] === 'приёмщик' ? 'review' : 'run'
  if (TASK_HEADING.test(title)) return 'run'
  if (PROBE_TITLE.test(title) || i.contour === 'lab') return 'probe'
  if ((i.profile && AUTO_PROFILES.includes(i.profile)) || AUTO_TITLE.test(title)) return 'auto'
  if (i.workspace === 'rp' || i.profile === 'rp' || i.persona) return 'rp'
  const space = i.workspace || 'default'
  if (i.contour === 'dev' && space === 'default') return 'probe'
  return 'talk'
}

/**
 * Происхождение имени без явной пометки (бэкфилл, DEV-428 §3): 40 символов с «…» —
 * `auto`; ручное переименование ACP (`userTitle` связи) — `user`; остальные с
 * заголовком — `agent` у ACP, `user` у прочих (у nr имя дают только человек и
 * создатель). Нет заголовка — `undefined`.
 */
export function titleSourceOf(i: { explicit?: unknown; title?: string; userTitle?: boolean; acp?: boolean }): TitleSource | undefined {
  if (isTitleSource(i.explicit)) return i.explicit
  if (!i.title) return undefined
  if (i.userTitle) return 'user'
  if (isAutoTitle(i.title)) return 'auto'
  return i.acp ? 'agent' : 'user'
}
