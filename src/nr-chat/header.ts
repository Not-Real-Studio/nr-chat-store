/**
 * Шапка `%meta` уровня файла (DEV-243): короткое машинное — в строке маркера,
 * всё, что читает и правит человек, — телами `%%`-подузлов шапки
 * (nrlib/CLAUDE.md «Файлы, которые пишет код, читает человек»).
 *
 *   %meta {id, title, profile, userId, botName, botAvatar, model, sessionMeta: {короткое}}
 *   %%character roxie {kind: 'char', name: 'Roxie', avatar: 'file:…', format: 'mdd'}
 *   <карта CCv3 телом: mdd через инжектированный кодек, иначе json5>
 *   %%profile inline {format: 'json5'}
 *   <inline-профиль>
 *   %%lorebook {format: 'json5'}
 *   <длинное значение меты сессии `lorebook`>
 *
 * Логический вид шапки (`headerView`) — прежний объект меты (`personas`,
 * `profileDoc`, `sessionMeta` целиком): драйвер работает с ним, раскладка на
 * маркер и подузлы — только здесь. Чтение понимает и старый вариант (всё в
 * строке маркера, DEV-237); первая же правка шапки раскладывает по-новому.
 */

import { parse, parseJson5, stringifyJson5, stringify, type ChatMessage } from '@notrealstudio/nr-chat'
import { META_ROLE, type SessionHeader, type SubNode } from './session.js'
import { decodeSubBody, type PartDecoders } from './parts.js'

/** Подузел персоны: `%%character <id> {kind, name, avatar?, …, format}` + тело. */
export const PERSONA_SUB = 'character'
/** Подузел inline-профиля: `%%profile inline {format: 'json5'}` + тело. */
export const PROFILE_SUB = 'profile'
/** Роли подузлов шапки, которые не мета сессии (из `meta.get` не отдаются). */
export const RESERVED_HEADER_SUBS: ReadonlySet<string> = new Set([PERSONA_SUB, PROFILE_SUB])

/** Строка маркера длиннее — уже не «с одного взгляда» (правило nrlib/CLAUDE.md). */
export const MARKER_MAX = 300
/** Скаляр в мете маркера не длиннее этого и без `\n`; иначе — телом. */
const SHORT_MAX = 120

/**
 * Кодек карты (DEV-243): `format` подузла персоны, карта → текст и обратно.
 * Стенд инжектирует mdd из nr-cards; без кодека карта пишется json5.
 */
export interface CardCodec {
  format: string
  encode(card: Record<string, unknown>): string
  decode(text: string): Record<string, unknown>
}

export interface HeaderCodecs {
  decoders?: PartDecoders
  card?: CardCodec
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Короткое машинное значение — место ему в маркере. */
export function isShort(v: unknown): boolean {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return true
  if (typeof v === 'string') return v.length <= SHORT_MAX && !v.includes('\n')
  if (Array.isArray(v) || isRecord(v)) {
    let s: string
    try {
      s = stringifyJson5(v)
    } catch {
      return false
    }
    return s.length <= SHORT_MAX * 1.5 && !hasNewlineDeep(v)
  }
  return false
}

function hasNewlineDeep(v: unknown): boolean {
  if (typeof v === 'string') return v.includes('\n')
  if (Array.isArray(v)) return v.some(hasNewlineDeep)
  if (isRecord(v)) return Object.values(v).some(hasNewlineDeep)
  return false
}

const RE_BARE_KEY = /^[A-Za-z_$][\w$]*$/

/** JSON5 с отступами — тело подузла читается и правится человеком. */
export function prettyJson5(v: unknown, indent = ''): string {
  const next = indent + '  '
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    if (v.every((x) => !isRecord(x) && !Array.isArray(x)) && stringifyJson5(v).length <= 80) return stringifyJson5(v)
    return '[\n' + v.map((x) => next + prettyJson5(x, next)).join(',\n') + ',\n' + indent + ']'
  }
  if (isRecord(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined)
    if (entries.length === 0) return '{}'
    const key = (k: string) => (RE_BARE_KEY.test(k) ? k : stringifyJson5(k))
    return '{\n' + entries.map(([k, x]) => `${next}${key(k)}: ${prettyJson5(x, next)}`).join(',\n') + ',\n' + indent + '}'
  }
  return stringifyJson5(v)
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isRecord(a) && isRecord(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

function parseJson5Body(body: string): unknown {
  const t = body.trim()
  if (t === '') return undefined
  try {
    return parseJson5(t)
  } catch {
    return undefined
  }
}

// ── персоны ──────────────────────────────────────────────────────────────────

/** Поля персоны, которые идут в мету подузла, если короткие. */
const PERSONA_META_KEYS = ['kind', 'name', 'avatar', 'model', 'color', 'gender', 'src'] as const

/** `%%character` → персона. Тело — карта (`format` кодека) или json5 прочих полей. */
function personaOf(sub: SubNode, codecs: HeaderCodecs): Record<string, unknown> {
  const { format, ...meta } = sub.meta ?? {}
  const p: Record<string, unknown> = {}
  if (sub.name !== undefined) p.id = sub.name
  Object.assign(p, meta)
  if (typeof format !== 'string' || format === 'json5') {
    const body = parseJson5Body(sub.body)
    if (isRecord(body)) Object.assign(p, body)
    return p
  }
  const dec = codecs.card?.format === format ? codecs.card.decode : codecs.decoders?.[format]
  if (dec) {
    try {
      const card = dec(sub.body)
      if (isRecord(card)) p.card = card
      return p
    } catch {
      // ниже — тело как есть
    }
  }
  // Формат, которого этот стор не знает: карты в виде нет, тело при записи
  // персоны без `card` сохраняется байтами (personaMessage).
  return p
}

/** Тело подузла в формате, которого стор не знает (кодека нет). */
function opaqueBody(sub: SubNode, codecs: HeaderCodecs): boolean {
  const format = sub.meta?.format
  if (typeof format !== 'string' || format === 'json5') return false
  if (codecs.card?.format === format || codecs.decoders?.[format]) return false
  return true
}

function personaMessage(p: Record<string, unknown>, codecs: HeaderCodecs, prev: SubNode | undefined): ChatMessage | string {
  const id = typeof p.id === 'string' ? p.id : undefined
  const meta: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(p)) {
    if (k === 'id' || v === undefined) continue
    if ((PERSONA_META_KEYS as readonly string[]).includes(k) && isShort(v) && typeof v !== 'object') meta[k] = v
    else rest[k] = v
  }
  // Подузел не изменился — байтами как был (ручная правка и формат целы).
  if (prev && deepEqual(personaOf(prev, codecs), p)) return subText(prev)
  if (prev && opaqueBody(prev, codecs) && Object.keys(rest).length === 0) {
    return { role: `%${PERSONA_SUB}`, ...(id !== undefined ? { name: id } : {}), meta: { ...meta, format: prev.meta?.format }, body: prev.body }
  }
  const keys = Object.keys(rest)
  let body = ''
  let format: string | undefined
  if (keys.length === 1 && keys[0] === 'card' && isRecord(rest.card) && codecs.card) {
    try {
      const text = codecs.card.encode(rest.card)
      if (deepEqual(codecs.card.decode(text), rest.card)) {
        body = text
        format = codecs.card.format
      }
    } catch {
      // кодек не справился — json5 ниже
    }
  }
  if (format === undefined && keys.length > 0) {
    body = prettyJson5(rest)
    format = 'json5'
  }
  const msg: ChatMessage = { role: `%${PERSONA_SUB}`, body }
  if (id !== undefined) msg.name = id
  const m = format ? { ...meta, format } : meta
  if (Object.keys(m).length > 0) msg.meta = m
  return msg
}

// ── вид и запись ─────────────────────────────────────────────────────────────

/**
 * Логический вид шапки: строка маркера ∪ подузлы. Старый вариант (всё в строке
 * маркера) читается как есть; подузлы сильнее строки.
 */
export function headerView(header: SessionHeader | undefined, codecs: HeaderCodecs = {}): Record<string, unknown> {
  if (!header) return {}
  const out: Record<string, unknown> = { ...header.meta }
  const personaSubs = header.subNodes.filter((s) => s.kind === PERSONA_SUB)
  if (personaSubs.length > 0) {
    out.personas = personaSubs.map((s) => personaOf(s, codecs))
    const bot = botOf(header)
    if (out.botName === undefined && bot.botName !== undefined) out.botName = bot.botName
    if (out.botAvatar === undefined && bot.botAvatar !== undefined) out.botAvatar = bot.botAvatar
  }
  const profileSub = header.subNodes.find((s) => s.kind === PROFILE_SUB)
  if (profileSub) {
    const doc = parseJson5Body(profileSub.body)
    if (isRecord(doc)) out.profileDoc = doc
  }
  const subMeta: Record<string, unknown> = {}
  for (const sub of header.subNodes) {
    if (RESERVED_HEADER_SUBS.has(sub.kind)) continue
    subMeta[sub.kind] = decodeSubBody(sub, codecs.decoders)
  }
  if (Object.keys(subMeta).length > 0) {
    const stored = isRecord(header.meta.sessionMeta) ? header.meta.sessionMeta : {}
    out.sessionMeta = { ...subMeta, ...stored }
  }
  return out
}

/** Бот списка из первого `%%character {kind: 'char'}` (имя, аватар) — без разбора тел. */
export function botOf(header: SessionHeader | undefined): { botName?: string; botAvatar?: string } {
  const sub = header?.subNodes.find((s) => s.kind === PERSONA_SUB && s.meta?.kind === 'char')
  const out: { botName?: string; botAvatar?: string } = {}
  if (typeof sub?.meta?.name === 'string' && sub.meta.name !== '') out.botName = sub.meta.name
  if (typeof sub?.meta?.avatar === 'string' && sub.meta.avatar !== '') out.botAvatar = sub.meta.avatar
  return out
}

/** Мета сессии из шапки (`meta.get`): строка маркера ∪ подузлы, без персон и профиля. */
export function headerSessionMeta(header: SessionHeader | undefined, codecs: HeaderCodecs = {}): Record<string, unknown> {
  const v = headerView(header, codecs).sessionMeta
  return isRecord(v) ? { ...v } : {}
}

/** Подузел байтами исходника (ручное форматирование цело); без исходника — заново. */
function subText(sub: SubNode): string {
  const src = sourceOf.get(sub)
  if (src !== undefined) return src.slice(sub.message.span.start, sub.message.span.end).replace(/\n+$/, '')
  return stringify([{ role: sub.rawRole, ...(sub.name !== undefined ? { name: sub.name } : {}), ...(sub.meta ? { meta: sub.meta } : {}), body: sub.body }]).replace(/\n$/, '')
}

const sourceOf = new WeakMap<SubNode, string>()

/**
 * Логический вид → текст шапки (маркер, тело шапки, подузлы), без `\n` в конце.
 * Неизменённые подузлы — байтами как были.
 */
export function renderHeader(
  name: string | undefined,
  view: Record<string, unknown>,
  prev: SessionHeader | undefined,
  srcText: string | undefined,
  codecs: HeaderCodecs = {},
): string {
  const { personas, profileDoc, sessionMeta, ...marker } = view
  if (prev && srcText !== undefined) for (const sub of prev.subNodes) sourceOf.set(sub, srcText)
  const parts: (ChatMessage | string)[] = []
  const prevSubs = prev?.subNodes ?? []

  // мета сессии: короткое — в маркер, длинное — подузлом `%%<ключ>`
  const shortMeta: Record<string, unknown> = {}
  const longMeta: [string, unknown][] = []
  if (isRecord(sessionMeta)) {
    for (const [k, v] of Object.entries(sessionMeta)) {
      if (v === undefined) continue
      if (isShort(v) || RESERVED_HEADER_SUBS.has(k) || !/^[A-Za-z_][\w.-]*$/.test(k)) shortMeta[k] = v
      else longMeta.push([k, v])
    }
  }
  // Бот списка — первая char-персона: при персонах подузлами в маркере не дублируется.
  const char = Array.isArray(personas) ? (personas.find((p) => isRecord(p) && p.kind === 'char') as Record<string, unknown> | undefined) : undefined
  if (char && marker.botName === char.name) delete marker.botName
  if (char && marker.botAvatar === char.avatar) delete marker.botAvatar

  const head: ChatMessage = { role: META_ROLE, body: prev?.body ?? '' }
  if (name !== undefined) head.name = name
  // Маркер всё равно длиннее порога — короткие ключи меты уходят подузлами,
  // самые длинные первыми.
  const markerLen = () => stringify([{ ...head, body: '', meta: { ...marker, ...(Object.keys(shortMeta).length > 0 ? { sessionMeta: shortMeta } : {}) } }]).replace(/\n$/, '').length
  while (markerLen() > MARKER_MAX) {
    const movable = Object.entries(shortMeta).filter(([k]) => !RESERVED_HEADER_SUBS.has(k) && /^[A-Za-z_][\w.-]*$/.test(k))
    if (movable.length === 0) break
    movable.sort((a, b) => stringifyJson5(b[1]).length - stringifyJson5(a[1]).length)
    const [k, v] = movable[0]
    delete shortMeta[k]
    longMeta.push([k, v])
  }
  if (Object.keys(shortMeta).length > 0) marker.sessionMeta = shortMeta
  if (Object.keys(marker).length > 0) head.meta = marker
  parts.push(head)

  if (Array.isArray(personas)) {
    const prevBy = new Map(prevSubs.filter((s) => s.kind === PERSONA_SUB && s.name).map((s) => [s.name!, s]))
    for (const p of personas) {
      if (!isRecord(p)) continue
      parts.push(personaMessage(p, codecs, typeof p.id === 'string' ? prevBy.get(p.id) : undefined))
    }
  }
  if (isRecord(profileDoc)) {
    const prevSub = prevSubs.find((s) => s.kind === PROFILE_SUB)
    const prevDoc = prevSub ? parseJson5Body(prevSub.body) : undefined
    if (prevSub && deepEqual(prevDoc, profileDoc)) parts.push(subText(prevSub))
    else parts.push({ role: `%${PROFILE_SUB}`, name: typeof marker.profile === 'string' ? marker.profile : 'inline', meta: { format: 'json5' }, body: prettyJson5(profileDoc) })
  }
  for (const [k, v] of longMeta) {
    const prevSub = prevSubs.find((s) => s.kind === k)
    if (prevSub && deepEqual(decodeSubBody(prevSub, codecs.decoders), v)) {
      parts.push(subText(prevSub))
      continue
    }
    if (typeof v === 'string' && !isShort(v)) parts.push({ role: `%${k}`, body: v })
    else parts.push({ role: `%${k}`, meta: { format: 'json5' }, body: prettyJson5(v) })
  }

  return parts.map((p) => (typeof p === 'string' ? p.replace(/\n$/, '') : stringify([p]).replace(/\n$/, ''))).join('\n')
}

/**
 * Нарушения правила nrlib/CLAUDE.md «Файлы, которые пишет код, читает человек»
 * в тексте `.mds` (DEV-243, тест writer'ов): строка маркера длиннее
 * {@link MARKER_MAX}, строка с `\n` в мете маркера. Пусто — файл читается глазами.
 */
export function readabilityViolations(text: string): string[] {
  const out: string[] = []
  for (const m of parse(text, { spans: true })) {
    const line = text.slice(m.span.start, text.indexOf('\n', m.span.start) === -1 ? text.length : text.indexOf('\n', m.span.start))
    if (line.length > MARKER_MAX) out.push(`маркер %${m.role} длиннее ${MARKER_MAX} (${line.length}): ${line.slice(0, 80)}…`)
    if (m.meta) newlinePaths(m.meta, `%${m.role}`, out)
  }
  return out
}

function newlinePaths(v: unknown, path: string, out: string[]): void {
  if (typeof v === 'string') {
    if (v.includes('\n')) out.push(`\\n в строке меты: ${path}`)
  } else if (Array.isArray(v)) v.forEach((x, i) => newlinePaths(x, `${path}[${i}]`, out))
  else if (isRecord(v)) for (const [k, x] of Object.entries(v)) newlinePaths(x, `${path}.${k}`, out)
}
