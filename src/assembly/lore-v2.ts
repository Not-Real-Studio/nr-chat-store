/**
 * Лорбук v2 (DEV-446, `nrchat.dev/specs/lorebook-v2-spec.md`): подача — свойство
 * книги, подбор ключами и/или эмбедами, без бюджета. Чистые функции, без IO:
 * косинусы эмбедов считает хост (backend-nr) до сборки и кладёт во вход
 * (`LoreV2Input.embed`), калибровка порога — {@link calibratedThreshold}.
 *
 * Подача (§2): `prefix` — книга целиком в system; `sticky` — сработавшая запись
 * закрепляется за репликой игрока (`meta.lore` реплики) и дальше стоит после неё
 * на всех ходах; `once` — в хвост одного хода (после реплики, до post); `classic`
 * — прежний {@link selectLore} один в один.
 *
 * Балл записи (§3) — максимум по окну `scan` от `вес_i × сходство_i`: ключ — 1,
 * эмбед — косинус, `both` — косинус + 0.3 за ключ. `keys` проходит при балле > 0,
 * `embed`/`both` — при балле ≥ порога (явный `threshold` или калибровка записи).
 */

import { estimateTokens } from './tokens.js'
import {
  DEFAULT_SCAN_DEPTH,
  entryName,
  entryPosition,
  keyMatches,
  lorebookOf,
  selectLore,
  type LoreOptions,
  type LoreSelection,
  type LoreSourceKind,
  type Lorebook,
  type LorebookEntry,
} from './lorebook.js'

export type LoreDelivery = 'prefix' | 'sticky' | 'once' | 'classic'
export type LoreMatch = 'keys' | 'embed' | 'both'
export type LoreEmbedOn = 'name' | 'text' | 'field'
/** Как идут `sticky`/`once` (§4): сообщением `system` посреди ленты или текстом в реплику игрока. */
export type LoreRole = 'system' | 'user'

export const LORE_DELIVERIES: readonly LoreDelivery[] = ['prefix', 'sticky', 'once', 'classic']
/** Книга без `extensions.nr` целиком ≤ стольких токенов — `prefix` (§2.5). */
export const PREFIX_SIZE_LIMIT = 4000
/** Прибавка к сходству за совпавший ключ в `both` (§3). */
export const BOTH_KEY_BONUS = 0.3
/** Запас калибровки над максимумом несвязанных фраз (§3.1). */
export const CALIBRATION_MARGIN = 0.05
/**
 * Заведомо несвязанные фразы калибровки (§3.1, донор Marinara): рус + англ.
 * Порог записи = максимум её косинусов с ними + {@link CALIBRATION_MARGIN}.
 */
export const CALIBRATION_PHRASES: readonly string[] = [
  'Пошли есть мороженое, погода сегодня хорошая.',
  'The quarterly tax report is due next Tuesday.',
  'Please restart the router and check the cable.',
]
/** Порядок источников книг (§1, порядок таблицы) — для порядка `prefix`. */
export const LORE_V2_SOURCES = ['bot', 'persona', 'session', 'profile'] as const
export type LoreV2SourceKind = (typeof LORE_V2_SOURCES)[number]

/** Книга со своим источником и стабильным id (закрепления ссылаются на него). */
export interface LoreBookV2 {
  kind: LoreV2SourceKind
  /** Стабильный id книги: путь файла, `bot:<персона>`, `persona:<персона>`, `session:<n>`. */
  id: string
  book: Lorebook
  /** Путь файла (библиотека, профиль) — для дедупа и UI. */
  path?: string
  /** Чья книга (персона-владелец) — для UI. */
  owner?: string
}

/** Закрепление `sticky` (`meta.lore` реплики игрока) и запись ротации `once` (`meta.loreOnce`). */
export interface LorePin {
  book: string
  entry: string
  variant?: number
}

/** Сообщение окна скана: только user/assistant ветки, в порядке ленты. */
export interface LoreScanMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** `meta.lore` / `meta.loreOnce` этого сообщения (реплики игрока). */
  pins?: readonly LorePin[]
  once?: readonly LorePin[]
}

/** Косинусы эмбедов, посчитанные хостом: ключ записи → сообщение → косинус. */
export interface LoreEmbedScores {
  /** `entryKey(book, entry)` → (id сообщения → косинус). */
  sims: Map<string, Map<string, number>>
  /** Калиброванный порог записи (`entryKey` → порог). */
  thresholds?: Map<string, number>
}

export interface LoreV2Input {
  books: readonly LoreBookV2[]
  history: readonly LoreScanMessage[]
  /** `$lore_delivery` профиля/агента: для книг без своей подачи (перебивает дефолт по размеру). */
  delivery?: LoreDelivery
  /** `$lore_role` профиля/агента. */
  role?: LoreRole
  /** Косинусы эмбедов; нет — `embed` записи не срабатывают, `both` — ключами. */
  embed?: LoreEmbedScores
  /** Предупреждения рана (эмбеддер лёг и т. п.) — в инъекции. */
  warnings?: readonly string[]
  /** Seed стабильного выбора в группе — id сессии. */
  seed?: string
  /** Раскрыть `{{char}}`/`{{user}}`. */
  expand?: (text: string) => string
  /** Карточка для скана ключей (`scan_card`). */
  cardText?: string
  scanCard?: boolean
  /** Impersonate: `once` и закрепления не идут (§4), `prefix` — идёт. */
  impersonate?: boolean
  /** Опции классики (`classic`-книги). */
  classic?: Pick<LoreOptions, 'budget' | 'depthPositions' | 'priority'>
}

/** Сработавшая запись v2. */
export interface LoreFired {
  /** id книги. */
  book: string
  bookName: string
  /** uid записи в книге. */
  entry: string
  name: string
  content: string
  source: LoreV2SourceKind
  delivery: Exclude<LoreDelivery, 'classic'>
  /** Балл (§3): `prefix` — 1. */
  score: number
  /** Почему: `constant`, `prefix`, `ключ «k» @1`, `cos 0.71 @2`, `закреплена`. */
  reason: string
  /** Позиция в окне скана, давшая балл (1 — последнее сообщение). */
  at?: number
  variant?: number
  /** `prefix`: до/после карточки. */
  position?: 'before_char' | 'after_char'
  /** `sticky`: id реплики-якоря. */
  anchor?: string
  /** `sticky`: закреплена на этом ходу (новое закрепление). */
  fresh?: boolean
  tokens: number
}

/** Что увидела отладка у записи, не прошедшей порог/лимит/группу. */
export interface LoreMissed {
  book: string
  entry: string
  name: string
  score: number
  reason: string
}

export interface LoreV2Selection {
  /** System: книги `prefix` и `constant`, в детерминированном порядке. */
  prefix: LoreFired[]
  /** Закреплённые (старые и новые), в порядке ленты якорей. */
  sticky: LoreFired[]
  /** Хвост этого хода. */
  once: LoreFired[]
  /** Классика: книги `classic` старым отбором. */
  classic?: LoreSelection
  /** Новые закрепления — в `meta.lore` реплики `anchor`. */
  pins: LorePin[]
  /** Варианты `once` этого хода — в `meta.loreOnce` реплики (ротация §5). */
  oncePins: LorePin[]
  /** Реплика игрока этого хода (куда писать `pins`/`oncePins`). */
  anchor?: string
  /** Сработавшие, но не вошедшие (лимит, группа) и ниже порога — для отладки. */
  missed: LoreMissed[]
  warnings: string[]
  role: LoreRole
}

// ────────────────────────────────────────────────────────────────────────────
// Настройки книги и записи
// ────────────────────────────────────────────────────────────────────────────

/** Настройки v2 книги/записи (`extensions.nr`). */
export interface LoreNrSettings {
  delivery?: LoreDelivery
  match?: LoreMatch
  scan?: number[]
  threshold?: number
  limit?: number
  embed_on?: LoreEmbedOn
}

export function nrOf(o: unknown): Record<string, unknown> {
  if (!isRecord(o)) return {}
  const ext = o.extensions
  return isRecord(ext) && isRecord(ext.nr) ? ext.nr : {}
}

function hasNr(book: Lorebook): boolean {
  return isRecord(book.extensions) && isRecord((book.extensions as Record<string, unknown>).nr)
}

function deliveryOf(v: unknown): LoreDelivery | undefined {
  return typeof v === 'string' && (LORE_DELIVERIES as readonly string[]).includes(v) ? (v as LoreDelivery) : undefined
}

function matchOf(v: unknown): LoreMatch | undefined {
  return v === 'keys' || v === 'embed' || v === 'both' ? v : undefined
}

function scanOf(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined
  const w = v.map(Number).filter((x) => Number.isFinite(x) && x >= 0)
  return w.length ? w : undefined
}

function numOf(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** Записи книги, которые идут в работу: `enabled` и с текстом. */
export function liveEntries(book: Lorebook): Array<{ entry: LorebookEntry; index: number; uid: string }> {
  if (!Array.isArray(book.entries)) return []
  const out: Array<{ entry: LorebookEntry; index: number; uid: string }> = []
  ;(book.entries as unknown[]).forEach((raw, index) => {
    if (!isRecord(raw)) return
    const entry = raw as LorebookEntry
    if (entry.enabled === false) return
    const content = typeof entry.content === 'string' ? entry.content : ''
    const variants = variantsOf(entry)
    if (content.trim() === '' && !variants.length) return
    out.push({ entry, index, uid: entryUid(entry, index) })
  })
  return out
}

/** uid записи: `id` (CCv3) → `uid` (ST) → индекс. */
export function entryUid(entry: LorebookEntry, index: number): string {
  for (const v of [entry.id, entry.uid]) if ((typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v !== '')) return String(v)
  return `#${index}`
}

/** Ключ записи в картах баллов: `<книга>\u0001<uid>`. */
export function entryKey(book: string, entry: string): string {
  return `${book}\u0001${entry}`
}

/** Токены всех `enabled` записей книги (для дефолта по размеру). */
export function bookTokens(book: Lorebook): number {
  return liveEntries(book).reduce((n, { entry }) => n + estimateTokens(String(entry.content ?? '')), 0)
}

/**
 * Подача книги (§2.5): `extensions.nr.delivery` книги → `$lore_delivery` →
 * по размеру (≤ 4k — `prefix`, иначе `once`).
 */
export function bookDelivery(book: Lorebook, override?: LoreDelivery): LoreDelivery {
  const own = deliveryOf(nrOf(book).delivery)
  if (own) return own
  if (override) return override
  return bookTokens(book) <= PREFIX_SIZE_LIMIT ? 'prefix' : 'once'
}

/** Окно скана книги: `extensions.nr.scan` → `[1]` у книги с `extensions.nr`, иначе `scan_depth` весами 1 (нет — `[1,1]`). */
export function bookScan(book: Lorebook): number[] {
  const own = scanOf(nrOf(book).scan)
  if (own) return own
  if (hasNr(book)) return [1]
  const d = book.scan_depth
  const depth = typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.floor(d) : 2
  return Array.from({ length: depth }, () => 1)
}

/** Настройки записи с учётом книги (запись перебивает любое). */
export interface EntrySettings {
  delivery: LoreDelivery
  match: LoreMatch
  scan: number[]
  threshold?: number
  embedOn: LoreEmbedOn
  group?: string
}

export function entrySettings(book: Lorebook, entry: LorebookEntry, override?: LoreDelivery): EntrySettings {
  const b = nrOf(book)
  const e = nrOf(entry)
  const delivery = entry.constant === true ? 'prefix' : (deliveryOf(e.delivery) ?? bookDelivery(book, override))
  const match = matchOf(e.match) ?? matchOf(b.match) ?? 'keys'
  const scan = scanOf(e.scan) ?? bookScan(book)
  const threshold = numOf(e.threshold) ?? numOf(b.threshold)
  const embedOnRaw = e.embed_on ?? b.embed_on
  const embedOn: LoreEmbedOn = embedOnRaw === 'name' || embedOnRaw === 'text' || embedOnRaw === 'field' ? embedOnRaw : typeof e.embed === 'string' && e.embed.trim() ? 'field' : 'name'
  const g = e.group ?? entry.group ?? (isRecord(entry.extensions) ? (entry.extensions as Record<string, unknown>).group : undefined)
  const group = typeof g === 'string' && g.trim() ? g.trim() : undefined
  return { delivery, match, scan, ...(threshold !== undefined ? { threshold } : {}), embedOn, ...(group ? { group } : {}) }
}

/** Лимит книги за ход (§3). */
export function bookLimit(book: Lorebook): number | undefined {
  const n = numOf(nrOf(book).limit)
  return n !== undefined && n > 0 ? Math.floor(n) : undefined
}

/** Варианты текста записи (`extensions.nr.variants`). */
export function variantsOf(entry: LorebookEntry): string[] {
  const v = nrOf(entry).variants
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
}

/**
 * Что эмбедить у записи (§3): `name` — имя/`comment` + ключи; `text` —
 * содержимое; `field` — `extensions.nr.embed` (нет — `name`).
 */
export function embedTextOf(entry: LorebookEntry, index: number, on: LoreEmbedOn): string {
  if (on === 'text') return String(entry.content ?? '').trim()
  if (on === 'field') {
    const f = nrOf(entry).embed
    if (typeof f === 'string' && f.trim()) return f.trim()
  }
  const keys = strings(entry.keys)
  const name = entryName(entry, index)
  return [name, ...keys.filter((k) => k !== name)].join(', ')
}

// ────────────────────────────────────────────────────────────────────────────
// Книги сессии из источников (§1)
// ────────────────────────────────────────────────────────────────────────────

export interface LoreBooksInput {
  /** `meta.lorebook` (старое поле) — книга первой char-персоны. */
  metaLorebook?: unknown
  /** `meta.lorebooks: [{book} | {path}]` — книги сессии; файловые уже прочитаны (`resolved`). */
  sessionBooks?: unknown
  /** Прочитанные книги библиотеки по пути (`meta.lorebooks[].path`). */
  resolved?: ReadonlyMap<string, Lorebook>
  /** char-персоны сессии (их `card.character_book` / `lorebook`). */
  chars: ReadonlyArray<{ id: string; card?: unknown; lorebook?: unknown }>
  /** user-персона: `card.character_book` / `lorebook`. */
  user?: { id: string; card?: unknown; lorebook?: unknown }
  /** Книги профиля (`$lorebook`) с путями. */
  profile?: ReadonlyArray<{ book: Lorebook; path?: string }>
}

/** Все книги сессии в порядке источников, без дублей (путь или хэш содержимого). */
export function loreBooks(input: LoreBooksInput): LoreBookV2[] {
  const out: LoreBookV2[] = []
  const seen = new Set<string>()
  const push = (b: LoreBookV2) => {
    const keys = [b.path ? `path:${b.path}` : undefined, `hash:${contentHash(b.book)}`].filter((k): k is string => !!k)
    if (keys.some((k) => seen.has(k))) return
    keys.forEach((k) => seen.add(k))
    out.push(b)
  }
  const metaBook = lorebookOf(input.metaLorebook)
  input.chars.forEach((c, i) => {
    const card = isRecord(c.card) ? c.card : {}
    // Старый `meta.lorebook` — книга первой char-персоны, заменяет её `character_book`.
    const book = (i === 0 ? metaBook : undefined) ?? lorebookOf(card.character_book) ?? lorebookOf(c.lorebook)
    if (book) push({ kind: 'bot', id: `bot:${c.id}`, book, owner: c.id })
  })
  if (!input.chars.length && metaBook) push({ kind: 'bot', id: 'bot:meta', book: metaBook })
  if (input.user) {
    const card = isRecord(input.user.card) ? input.user.card : {}
    const book = lorebookOf(card.character_book) ?? lorebookOf(input.user.lorebook)
    if (book) push({ kind: 'persona', id: `persona:${input.user.id}`, book, owner: input.user.id })
  }
  if (Array.isArray(input.sessionBooks)) {
    input.sessionBooks.forEach((raw, i) => {
      if (!isRecord(raw)) return
      if (raw.enabled === false) return
      if (typeof raw.path === 'string' && raw.path.trim()) {
        const book = input.resolved?.get(raw.path)
        if (book) push({ kind: 'session', id: raw.path, book, path: raw.path })
        return
      }
      const book = lorebookOf(raw.book)
      if (book) push({ kind: 'session', id: typeof raw.id === 'string' && raw.id ? raw.id : `session:${typeof book.name === 'string' && book.name ? book.name : i}`, book })
    })
  }
  ;(input.profile ?? []).forEach((p, i) => push({ kind: 'profile', id: p.path ?? `profile:${i}`, book: p.book, ...(p.path ? { path: p.path } : {}) }))
  return out
}

/** Пути книг сессии из библиотеки (`meta.lorebooks[].path`) — их читает хост. */
export function sessionBookPaths(sessionBooks: unknown): string[] {
  if (!Array.isArray(sessionBooks)) return []
  return sessionBooks.filter(isRecord).filter((b) => b.enabled !== false && typeof b.path === 'string' && b.path.trim()).map((b) => String(b.path))
}

function bookName(b: LoreBookV2): string {
  return typeof b.book.name === 'string' && b.book.name.trim() ? b.book.name.trim() : (b.path ?? b.id)
}

// ────────────────────────────────────────────────────────────────────────────
// План эмбедов (хост считает косинусы)
// ────────────────────────────────────────────────────────────────────────────

export interface LoreEmbedPlan {
  /** Записи с подбором `embed`/`both`: что эмбедить. */
  entries: Array<{ key: string; text: string; threshold?: number }>
  /** Сообщения окон скана этих записей. */
  messages: Array<{ id: string; text: string }>
}

/**
 * Что нужно эмбедить на этот ход: записи `embed`/`both` (не `prefix`, не
 * закреплённые на ветке) и сообщения их окон `scan`.
 */
export function loreEmbedPlan(input: Pick<LoreV2Input, 'books' | 'history' | 'delivery' | 'impersonate'>): LoreEmbedPlan {
  const entries: LoreEmbedPlan['entries'] = []
  const need = new Set<string>()
  if (input.impersonate) return { entries, messages: [] }
  const scanMsgs = [...input.history].reverse()
  for (const b of input.books) {
    if (bookDelivery(b.book, input.delivery) === 'classic' && !liveEntries(b.book).some(({ entry }) => deliveryOf(nrOf(entry).delivery))) continue
    for (const { entry, index, uid } of liveEntries(b.book)) {
      const s = entrySettings(b.book, entry, input.delivery)
      if (s.delivery === 'prefix' || s.delivery === 'classic' || s.match === 'keys') continue
      const text = embedTextOf(entry, index, s.embedOn)
      if (!text) continue
      entries.push({ key: entryKey(b.id, uid), text, ...(s.threshold !== undefined ? { threshold: s.threshold } : {}) })
      scanMsgs.slice(0, s.scan.length).forEach((m, i) => {
        if ((s.scan[i] ?? 0) > 0 && m.text.trim()) need.add(m.id)
      })
    }
  }
  const messages = input.history.filter((m) => need.has(m.id)).map((m) => ({ id: m.id, text: m.text }))
  return { entries, messages }
}

/** Косинус двух векторов. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Калиброванный порог записи (§3.1): максимум косинусов с несвязанными фразами + запас. */
export function calibratedThreshold(entry: ArrayLike<number>, unrelated: ReadonlyArray<ArrayLike<number>>, margin = CALIBRATION_MARGIN): number {
  let max = -1
  for (const u of unrelated) max = Math.max(max, cosine(entry, u))
  return round3(max + margin)
}

// ────────────────────────────────────────────────────────────────────────────
// Выбор
// ────────────────────────────────────────────────────────────────────────────

interface Candidate {
  b: LoreBookV2
  entry: LorebookEntry
  index: number
  uid: string
  s: EntrySettings
  score: number
  at?: number
  reason: string
}

/** Есть ли у книг классика (весь выбор старым отбором). */
function classicBooks(input: LoreV2Input): LoreBookV2[] {
  return input.books.filter((b) => bookDelivery(b.book, input.delivery) === 'classic')
}

export function selectLoreV2(input: LoreV2Input): LoreV2Selection {
  const expand = input.expand ?? ((t: string) => t)
  const role: LoreRole = input.role === 'user' ? 'user' : 'system'
  const out: LoreV2Selection = { prefix: [], sticky: [], once: [], pins: [], oncePins: [], missed: [], warnings: [...(input.warnings ?? [])], role }
  const history = input.history
  const scanMsgs = [...history].reverse()
  const lastUser = [...history].reverse().find((m) => m.role === 'user')
  if (lastUser) out.anchor = lastUser.id

  // Классика — старым отбором; закрепления и хвост её не касаются.
  const classic = classicBooks(input)
  if (classic.length) {
    out.classic = selectLore(
      classic.map((b) => ({ kind: (b.kind === 'session' ? 'profile' : b.kind) as LoreSourceKind, book: b.book })),
      history.map((m) => m.text).filter((t) => t.trim() !== ''),
      { expand, ...(input.scanCard ? { scanCard: true } : {}), ...(input.cardText !== undefined ? { cardText: input.cardText } : {}), ...(input.classic ?? {}) },
    )
  }
  const modern = input.books.filter((b) => !classic.includes(b))

  // ── prefix: детерминированный порядок — источник, имя/путь книги, порядок записей ──
  const ordered = [...modern].sort((a, b) => LORE_V2_SOURCES.indexOf(a.kind) - LORE_V2_SOURCES.indexOf(b.kind) || (input.books.indexOf(a) - input.books.indexOf(b)))
  for (const b of ordered) {
    for (const { entry, index, uid } of liveEntries(b.book)) {
      const s = entrySettings(b.book, entry, input.delivery)
      if (s.delivery !== 'prefix') continue
      const content = expand(contentOf(entry, undefined)).trim()
      if (!content) continue
      out.prefix.push({ book: b.id, bookName: bookName(b), entry: uid, name: entryName(entry, index), content, source: b.kind, delivery: 'prefix', score: 1, reason: entry.constant === true ? 'constant' : 'prefix', position: entryPosition(entry) === 'after_char' ? 'after_char' : 'before_char', tokens: estimateTokens(content) })
    }
  }
  if (input.impersonate) return out

  // ── закрепления, видимые на ветке ──
  const pinned = new Map<string, { anchor: string; variant?: number }>()
  for (const m of history) for (const p of m.pins ?? []) if (!pinned.has(entryKey(p.book, p.entry))) pinned.set(entryKey(p.book, p.entry), { anchor: m.id, ...(p.variant !== undefined ? { variant: p.variant } : {}) })
  const byId = new Map(modern.map((b) => [b.id, b]))
  // Ротация вариантов: последний показ каждого варианта (индекс сообщения).
  const shown = new Map<string, Map<number, number>>()
  history.forEach((m, i) => {
    for (const p of [...(m.pins ?? []), ...(m.once ?? [])]) {
      if (p.variant === undefined) continue
      const k = entryKey(p.book, p.entry)
      const v = shown.get(k) ?? new Map<number, number>()
      v.set(p.variant, i)
      shown.set(k, v)
    }
  })
  for (const m of history) {
    for (const p of m.pins ?? []) {
      const k = entryKey(p.book, p.entry)
      if (pinned.get(k)?.anchor !== m.id) continue
      const b = byId.get(p.book)
      const found = b ? liveEntries(b.book).find((e) => e.uid === p.entry) : undefined
      if (!b || !found) continue // книгу удалили / запись выключили — молча пропуск
      const content = expand(contentOf(found.entry, p.variant)).trim()
      if (!content) continue
      out.sticky.push({ book: b.id, bookName: bookName(b), entry: p.entry, name: entryName(found.entry, found.index), content, source: b.kind, delivery: 'sticky', score: 1, reason: 'закреплена', anchor: m.id, ...(p.variant !== undefined ? { variant: p.variant } : {}), tokens: estimateTokens(content) })
    }
  }

  // ── кандидаты хода ──
  const cands: Candidate[] = []
  for (const b of modern) {
    const bookWhole = wholeWordFlag(b.book) ?? wholeWordFlag(extOf(b.book))
    const scanCard = input.scanCard === true || extOf(b.book).scan_card === true
    for (const { entry, index, uid } of liveEntries(b.book)) {
      const s = entrySettings(b.book, entry, input.delivery)
      if (s.delivery === 'prefix' || s.delivery === 'classic') continue
      const k = entryKey(b.id, uid)
      if (s.delivery === 'sticky' && pinned.has(k)) continue
      const scored = scoreEntry(entry, s, k, scanMsgs, input.embed, bookWhole, scanCard ? input.cardText : undefined)
      if (scored.missed) {
        out.missed.push({ book: b.id, entry: uid, name: entryName(entry, index), score: scored.score, reason: scored.missed })
        continue
      }
      if (scored.reason === undefined) continue
      cands.push({ b, entry, index, uid, s, score: scored.score, ...(scored.at !== undefined ? { at: scored.at } : {}), reason: scored.reason })
    }
  }

  // ── группы: из сработавших одной группы — одна, с наибольшим баллом; при равенстве — по seed ──
  const winners = new Map<string, Candidate>()
  const seed = input.seed ?? ''
  for (const c of cands) {
    if (!c.s.group) continue
    const cur = winners.get(c.s.group)
    if (!cur || c.score > cur.score || (c.score === cur.score && tiebreak(seed, c.s.group, c) < tiebreak(seed, c.s.group, cur))) winners.set(c.s.group, c)
  }
  let fired = cands.filter((c) => {
    if (!c.s.group || winners.get(c.s.group) === c) return true
    out.missed.push({ book: c.b.id, entry: c.uid, name: entryName(c.entry, c.index), score: c.score, reason: `группа «${c.s.group}»` })
    return false
  })
  // Группа со `sticky`: победитель уже закреплён прежде — новых закреплений группы нет (§3.2).

  // ── лимит книги за ход, по баллу ──
  const byBook = new Map<LoreBookV2, Candidate[]>()
  for (const c of fired) byBook.set(c.b, [...(byBook.get(c.b) ?? []), c])
  const cut = new Set<Candidate>()
  for (const [b, list] of byBook) {
    const limit = bookLimit(b.book)
    if (limit === undefined || list.length <= limit) continue
    const ranked = [...list].sort((x, y) => y.score - x.score || orderOf(x.entry) - orderOf(y.entry) || x.index - y.index)
    for (const c of ranked.slice(limit)) {
      cut.add(c)
      out.missed.push({ book: b.id, entry: c.uid, name: entryName(c.entry, c.index), score: c.score, reason: `лимит ${limit}` })
    }
  }
  fired = fired.filter((c) => !cut.has(c))
  // Порядок нескольких записей хода — `insertion_order`, потом источник, потом книга.
  fired.sort((x, y) => orderOf(x.entry) - orderOf(y.entry) || LORE_V2_SOURCES.indexOf(x.b.kind) - LORE_V2_SOURCES.indexOf(y.b.kind) || input.books.indexOf(x.b) - input.books.indexOf(y.b) || x.index - y.index)

  for (const c of fired) {
    const k = entryKey(c.b.id, c.uid)
    const variants = variantsOf(c.entry)
    const variant = variants.length ? pickVariant(variants.length, shown.get(k)) : undefined
    const content = expand(contentOf(c.entry, variant)).trim()
    if (!content) continue
    const f: LoreFired = { book: c.b.id, bookName: bookName(c.b), entry: c.uid, name: entryName(c.entry, c.index), content, source: c.b.kind, delivery: c.s.delivery === 'sticky' ? 'sticky' : 'once', score: c.score, reason: c.reason, ...(c.at !== undefined ? { at: c.at } : {}), ...(variant !== undefined ? { variant } : {}), tokens: estimateTokens(content) }
    const pin: LorePin = { book: c.b.id, entry: c.uid, ...(variant !== undefined ? { variant } : {}) }
    if (f.delivery === 'sticky' && lastUser) {
      f.anchor = lastUser.id
      f.fresh = true
      out.sticky.push(f)
      out.pins.push(pin)
    } else {
      // `sticky` без реплики игрока (ход без реплики) — на этот ход хвостом.
      out.once.push(f)
      if (variant !== undefined) out.oncePins.push(pin)
    }
  }
  return out
}

/**
 * Балл записи по окну скана (§3). `reason` — сработала; `missed` — эмбед
 * посчитан, но ниже порога (для отладки).
 */
function scoreEntry(
  entry: LorebookEntry,
  s: EntrySettings,
  key: string,
  scanMsgs: readonly LoreScanMessage[],
  embed: LoreEmbedScores | undefined,
  bookWhole: boolean | undefined,
  card: string | undefined,
): { score: number; at?: number; reason?: string; missed?: string } {
  const opts = { caseSensitive: entry.case_sensitive === true, wholeWord: wholeWordOf(entry, bookWhole) }
  const keys = strings(entry.keys)
  const secondary = entry.selective === true ? strings(entry.secondary_keys) : []
  const window = scanMsgs.slice(0, s.scan.length)
  const windowText = window.map((m) => m.text).join('\n')
  const secondaryOk = !secondary.length || secondary.some((k) => keyMatches(card !== undefined ? `${windowText}\n${card}` : windowText, k, opts))
  const keyAt = (text: string) => (secondaryOk ? keys.find((k) => keyMatches(text, k, opts)) : undefined)
  const sims = embed?.sims.get(key)
  const useKeys = s.match !== 'embed'
  const useEmbed = s.match !== 'keys' && sims !== undefined

  let best = 0
  let at: number | undefined
  let why = ''
  window.forEach((m, i) => {
    const w = s.scan[i] ?? 0
    if (w <= 0) return
    const k = useKeys ? keyAt(m.text) : undefined
    let sim = 0
    let r = ''
    if (useEmbed) {
      const cos = sims!.get(m.id) ?? 0
      sim = cos + (k !== undefined ? BOTH_KEY_BONUS : 0)
      r = k !== undefined ? `cos ${round3(cos)} + ключ «${k.trim()}»` : `cos ${round3(cos)}`
    } else if (k !== undefined) {
      sim = 1
      r = `ключ «${k.trim()}»`
    }
    const v = w * sim
    if (v > best) {
      best = v
      at = i + 1
      why = r
    }
  })
  // Скан карточки — только ключами (§3).
  if (best === 0 && useKeys && card !== undefined) {
    const k = keyAt(card)
    if (k !== undefined) return { score: 1, reason: `карточка: ключ «${k.trim()}»` }
  }
  const score = round3(best)
  if (!useEmbed) return score > 0 ? { score, ...(at !== undefined ? { at } : {}), reason: `${why} @${at}` } : { score: 0 }
  const threshold = s.threshold ?? embed?.thresholds?.get(key)
  if (threshold === undefined) return { score, missed: 'нет порога' }
  if (score >= threshold) return { score, ...(at !== undefined ? { at } : {}), reason: `${why} @${at} ≥ ${round3(threshold)}` }
  return { score, missed: `ниже порога ${round3(threshold)}` }
}

/** Вариант, который в ветке показывали давнее всего (никогда — первый такой). */
function pickVariant(n: number, last: Map<number, number> | undefined): number {
  let pick = 0
  let oldest = Infinity
  for (let v = 0; v < n; v++) {
    const at = last?.get(v) ?? -1
    if (at < oldest) {
      oldest = at
      pick = v
    }
  }
  return pick
}

function contentOf(entry: LorebookEntry, variant: number | undefined): string {
  const variants = variantsOf(entry)
  if (variant !== undefined && variants[variant] !== undefined) return variants[variant]!
  return typeof entry.content === 'string' && entry.content.trim() ? entry.content : (variants[0] ?? '')
}

function tiebreak(seed: string, group: string, c: Candidate): number {
  return fnv1a(`${seed}\u0001${group}\u0001${c.b.id}\u0001${c.uid}`)
}

/** Стабильный хэш содержимого книги (дедуп источников). */
export function contentHash(book: Lorebook): string {
  return fnv1a(JSON.stringify(book.entries ?? null)).toString(36)
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function wholeWordOf(entry: LorebookEntry, bookWhole: boolean | undefined): boolean {
  return wholeWordFlag(extOf(entry)) ?? wholeWordFlag(entry) ?? bookWhole ?? false
}

function wholeWordFlag(o: Record<string, unknown>): boolean | undefined {
  const v = o.match_whole_words
  return typeof v === 'boolean' ? v : undefined
}

function extOf(o: Record<string, unknown>): Record<string, unknown> {
  return isRecord(o.extensions) ? o.extensions : {}
}

function orderOf(entry: LorebookEntry): number {
  return typeof entry.insertion_order === 'number' && Number.isFinite(entry.insertion_order) ? entry.insertion_order : 0
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Метка инъекции v2: `lorebook:<источник>/<подача>: <имя>`. */
export function loreV2Label(f: Pick<LoreFired, 'source' | 'delivery' | 'name'>): string {
  return `lorebook:${f.source}/${f.delivery}: ${f.name}`
}

/** Подпись причины для отладки: подача, балл, позиция, вариант, якорь. */
export function loreV2Reason(f: LoreFired): string {
  const parts = [`книга «${f.bookName}»`, f.reason]
  if (f.delivery !== 'prefix') parts.push(`балл ${f.score}`)
  if (f.variant !== undefined) parts.push(`вариант ${f.variant + 1}`)
  if (f.anchor && !f.fresh) parts.push(`якорь ${f.anchor}`)
  return parts.join(' · ')
}

/** Сколько ходов скана по умолчанию у классики — реэкспорт для потребителей. */
export { DEFAULT_SCAN_DEPTH }
