/**
 * Лорбук рана (RP-1b, RP-1c; SillyTavern-семантика, минимум): какие записи
 * войдут в промпт. Чистые функции, без IO. Перенесён из pi-ext-session-meta
 * (DEV-222) — семантика один в один, pi-ext реэкспортирует отсюда; потребители:
 * pi-ext (хук `before_agent_start`) и сборка backend-nr.
 *
 * Источники (DEV-180) — список, хук один:
 *   - `bot` — `meta.lorebook` сессии (CCv3 `character_book` карточки бота);
 *   - `persona` — `lorebook` user-персоны (character_book её карточки);
 *   - `profile` — файлы `$lorebook` профиля (CCv3 или ST world info).
 * Записи всех источников — в один пул, бюджет — общий.
 *
 * Правила:
 *   - только `enabled`;
 *   - `constant` — всегда;
 *   - иначе хоть один из `keys` встречается в последних `scan_depth` сообщениях
 *     (дефолт 4, книга может задать) — а при скане карточки (`scanCard` или
 *     `extensions.scan_card` книги) ещё и в тексте карточки бота/персоны; при
 *     `selective` с непустыми `secondary_keys` — ещё и хоть один из них (AND);
 *   - регистр — по `case_sensitive` записи (дефолт — без учёта); ключ — ПОДСТРОКОЙ
 *     (ключи-основы «академи», «башн» — Denis 02.10), слово целиком — только
 *     если запись или книга явно ставит `match_whole_words: true`;
 *   - порядок — `insertion_order` по возрастанию, при равных — бот → персона →
 *     профиль, дальше — как в книге;
 *   - бюджет — общий (`budget` опций: `$lorebook_budget` профиля; иначе
 *     максимум `token_budget` книг; иначе 16000) по `estimateTokens`: запись,
 *     которая не влезает, отбрасывается (счётчик `dropped`), следующие пробуют;
 *   - `position: after_char` (или число 1) — после блока карточки, всё прочее
 *     (`before_char`, пусто, Chub шлёт `""`) — до.
 *
 * Рекурсии нет и не будет (Denis: «рекурсия — зло для лорбука»); регэкспов
 * (`use_regex`), вероятностей и вторичных логик, кроме AND, нет — DEBT.
 *
 * Доработки по dsh-donor §10 (DEV-222) — за опциями, без них поведение прежнее:
 *   - `depthPositions` — запись «на глубине» (ST `position: 4` / CCv3
 *     `extensions.position: 4`, `depth`, `role`) встаёт в историю на глубине
 *     `depth` от конца, как character's note; без опции — до карточки;
 *   - `priority` — при нехватке бюджета первыми отбрасываются записи с меньшим
 *     `priority` (CCv3); порядок в промпте — по-прежнему `insertion_order`;
 *   - причина у каждой записи (`reason`): `constant`, `ключ «…»`, `карточка:
 *     ключ «…»`; отброшенные — `droppedEntries` с причиной `бюджет`.
 */

import { estimateTokens } from './tokens.js'

/** Дефолт глубины сканирования (ST — 2; Denis 02.10 — 4). */
export const DEFAULT_SCAN_DEPTH = 4

/** Дефолт общего бюджета лорбука в токенах (Denis 02.10: реальный ~16k+). */
export const DEFAULT_TOKEN_BUDGET = 16000

/** Метка инъекции в рецепте: `lorebook:<источник>: <имя записи>`. */
export const LOREBOOK_INJECTION_SOURCE = 'lorebook'

/** Откуда книга. Порядок в массиве — порядок при равном `insertion_order`. */
export const LORE_SOURCE_KINDS = ['bot', 'persona', 'profile'] as const
export type LoreSourceKind = (typeof LORE_SOURCE_KINDS)[number]

/** Запись лорбука, как её кладёт CCv3 (лишние поля — как есть). */
export interface LorebookEntry {
  keys?: unknown
  secondary_keys?: unknown
  content?: unknown
  enabled?: unknown
  constant?: unknown
  selective?: unknown
  case_sensitive?: unknown
  insertion_order?: unknown
  position?: unknown
  name?: unknown
  comment?: unknown
  extensions?: unknown
  [key: string]: unknown
}

export interface Lorebook {
  name?: unknown
  entries?: unknown
  scan_depth?: unknown
  token_budget?: unknown
  extensions?: unknown
  [key: string]: unknown
}

/** Книга с указанием, откуда она. */
export interface LoreSource {
  kind: LoreSourceKind
  book: Lorebook
}

export type LorePosition = 'before_char' | 'after_char' | 'at_depth'

/** Роль записи «на глубине» (ST `role`: 0 — system, 1 — user, 2 — assistant). */
export type LoreDepthRole = 'system' | 'user' | 'assistant'

/** Сработавшая запись: что вставить и куда. */
export interface FiredEntry {
  name: string
  content: string
  position: LorePosition
  tokens: number
  source: LoreSourceKind
  /** Почему сработала: `constant` | `ключ «k»` | `карточка: ключ «k»`. */
  reason: string
  /** `at_depth`: глубина от конца истории (0 — в конец) и роль. */
  depth?: number
  role?: LoreDepthRole
}

/** Сработавшая, но не вошедшая запись. */
export interface DroppedEntry {
  /** Метка рецепта `lorebook:<источник>: <имя>`. */
  label: string
  name: string
  source: LoreSourceKind
  tokens: number
  reason: string
}

export interface LoreSelection {
  before: FiredEntry[]
  after: FiredEntry[]
  /** Записи «на глубине» (только с `depthPositions`), в порядке `insertion_order`. */
  depth: FiredEntry[]
  /** Сработавшие, но не влезшие в бюджет — имена (`lorebook:<источник>: <имя>`). */
  dropped: string[]
  /** То же с причинами и размерами. */
  droppedEntries: DroppedEntry[]
  /** Бюджет, по которому шёл отбор. */
  budget: number
}

export interface LoreOptions {
  /** Общий бюджет (`$lorebook_budget` профиля); нет — максимум книг, иначе дефолт. */
  budget?: number
  /** Сканировать карточку у всех книг (`$lorebook_scan_card` профиля). */
  scanCard?: boolean
  /** Текст карточки бота и персоны для скана (description/personality/scenario). */
  cardText?: string
  /** Раскрыть `{{char}}`/`{{user}}` в тексте записи. */
  expand?: (text: string) => string
  /** Записи «на глубине» — в `depth` (иначе до карточки, как раньше). */
  depthPositions?: boolean
  /** При нехватке бюджета отбрасывать сначала записи с меньшим `priority`. */
  priority?: boolean
}

/**
 * Книга из чего угодно, что кладут на диск и в мету: CCv3 `character_book`
 * (`entries` — массив), карточка целиком (`data.character_book`), ST world info
 * (`entries` — объект `{uid: entry}`, поля `key`/`keysecondary`/`order`/`disable`…).
 * Не книга — `undefined`.
 */
export function lorebookOf(value: unknown): Lorebook | undefined {
  if (!isRecord(value)) return undefined
  if (Array.isArray(value.entries)) return value as Lorebook
  const data = value.data
  if (isRecord(data) && isRecord(data.character_book)) return lorebookOf(data.character_book)
  if (isRecord(value.entries)) return fromWorldInfo(value)
  return undefined
}

/** ST world info → CCv3-книга (поля, которые понимает отбор). */
function fromWorldInfo(wi: Record<string, unknown>): Lorebook {
  const entries = Object.values(wi.entries as Record<string, unknown>)
    .filter(isRecord)
    .map((e): LorebookEntry => {
      const ext: Record<string, unknown> = {}
      if (typeof e.matchWholeWords === 'boolean') ext.match_whole_words = e.matchWholeWords
      // Глубинная позиция ST (4) — в расширения CCv3: её читает только `depthPositions`.
      if (typeof e.position === 'number') ext.position = e.position
      if (typeof e.depth === 'number') ext.depth = e.depth
      if (typeof e.role === 'number') ext.role = e.role
      const priority = typeof e.priority === 'number' ? e.priority : undefined
      return {
        keys: e.key,
        secondary_keys: e.keysecondary,
        content: e.content,
        enabled: e.disable !== true,
        constant: e.constant === true,
        selective: e.selective === true,
        case_sensitive: e.caseSensitive === true,
        insertion_order: typeof e.order === 'number' ? e.order : 0,
        // ST: 0 — до карточки, 1 — после; прочие (AN, глубина, примеры) — пока до.
        position: e.position === 1 ? 'after_char' : 'before_char',
        name: typeof e.comment === 'string' ? e.comment : undefined,
        extensions: ext,
        ...(priority !== undefined ? { priority } : {}),
      }
    })
  const book: Lorebook = { entries }
  if (typeof wi.name === 'string') book.name = wi.name
  return book
}

/** Глубина сканирования книги: положительное целое, иначе дефолт. */
export function scanDepthOf(book: Lorebook): number {
  const d = book.scan_depth
  return typeof d === 'number' && Number.isFinite(d) && d > 0 ? Math.floor(d) : DEFAULT_SCAN_DEPTH
}

/** Бюджет книги: положительное число, иначе `undefined`. */
export function tokenBudgetOf(book: Lorebook): number | undefined {
  const b = book.token_budget
  return typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : undefined
}

/** Общий бюджет: явный → максимум книг → дефолт. */
export function poolBudget(sources: readonly LoreSource[], explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) return explicit
  const books = sources.map((s) => tokenBudgetOf(s.book)).filter((b): b is number => b !== undefined)
  return books.length ? Math.max(...books) : DEFAULT_TOKEN_BUDGET
}

/** Имя записи для рецепта: `name` → `comment` → первый ключ → `#индекс`. */
export function entryName(entry: LorebookEntry, index: number): string {
  for (const v of [entry.name, entry.comment]) if (typeof v === 'string' && v.trim() !== '') return v.trim()
  const first = strings(entry.keys)[0]
  return first ?? `#${index}`
}

/** Позиция записи: `after_char` | 1 — после карточки, прочее — до. */
export function entryPosition(entry: LorebookEntry): LorePosition {
  return entry.position === 'after_char' || entry.position === 1 ? 'after_char' : 'before_char'
}

/**
 * Запись «на глубине»: `position: 'at_depth'` | 4 у записи или
 * `extensions.position: 4` (так экспортирует ST). Глубина — `depth`
 * (расширения → поле, дефолт 4), роль — `role` (0/1/2 или имя, дефолт system).
 */
export function entryDepth(entry: LorebookEntry): { depth: number; role: LoreDepthRole } | undefined {
  const ext = extOf(entry)
  const at = entry.position === 'at_depth' || entry.position === 4 || ext.position === 4 || ext.position === 'at_depth'
  if (!at) return undefined
  const d = typeof ext.depth === 'number' ? ext.depth : entry.depth
  const depth = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? Math.floor(d) : 4
  const r = ext.role ?? entry.role
  const role: LoreDepthRole = r === 1 || r === 'user' ? 'user' : r === 2 || r === 'assistant' ? 'assistant' : 'system'
  return { depth, role }
}

/** Метка инъекции рецепта: `lorebook:bot: Butcher`. */
export function loreSourceLabel(source: LoreSourceKind, name: string): string {
  return `${LOREBOOK_INJECTION_SOURCE}:${source}: ${name}`
}

/**
 * Ключ в тексте. Слово целиком — границы по буквам/цифрам Unicode (кириллица
 * — тоже слово), ключ на краю не-буквой (`#tag`) — граница с той стороны не нужна.
 */
export function keyMatches(text: string, key: string, opts: { caseSensitive: boolean; wholeWord: boolean }): boolean {
  const k = key.trim()
  if (k === '') return false
  const flags = opts.caseSensitive ? 'u' : 'iu'
  const body = escapeRegExp(k)
  if (!opts.wholeWord) return new RegExp(body, flags).test(text)
  const head = /^[\p{L}\p{N}_]/u.test(k) ? '(?<![\\p{L}\\p{N}_])' : ''
  const tail = /[\p{L}\p{N}_]$/u.test(k) ? '(?![\\p{L}\\p{N}_])' : ''
  return new RegExp(head + body + tail, flags).test(text)
}

/**
 * Записи всех источников для этого рана. `messages` — тексты истории в
 * порядке ленты (последняя — реплика рана); у каждой книги сканируются её
 * последние `scan_depth`.
 */
export function selectLore(sources: readonly LoreSource[], messages: readonly string[], opts: LoreOptions = {}): LoreSelection {
  const expand = opts.expand ?? ((t: string) => t)
  const fired: Array<{ entry: LorebookEntry; index: number; rank: number; source: LoreSourceKind; reason: string }> = []
  sources.forEach((src, at) => {
    if (!Array.isArray(src.book.entries)) return
    const window = messages.slice(-scanDepthOf(src.book)).join('\n')
    const scanCard = opts.scanCard === true || extOf(src.book).scan_card === true
    const card = scanCard && opts.cardText ? opts.cardText : undefined
    const bookWhole = wholeWordFlag(src.book) ?? wholeWordFlag(extOf(src.book))
    const rank = LORE_SOURCE_KINDS.indexOf(src.kind) * 1000 + at
    ;(src.book.entries as unknown[]).forEach((raw, index) => {
      if (!isRecord(raw)) return
      const entry = raw as LorebookEntry
      if (entry.enabled === false) return
      const content = typeof entry.content === 'string' ? entry.content : ''
      if (content.trim() === '') return
      const reason = entry.constant === true ? 'constant' : triggered(entry, window, card, bookWhole)
      if (reason !== undefined) fired.push({ entry, index, rank, source: src.kind, reason })
    })
  })
  fired.sort((a, b) => orderOf(a.entry) - orderOf(b.entry) || a.rank - b.rank || a.index - b.index)

  const budget = poolBudget(sources, opts.budget)
  const out: LoreSelection = { before: [], after: [], depth: [], dropped: [], droppedEntries: [], budget }
  const items = fired.map(({ entry, index, source, reason }) => {
    const content = expand(String(entry.content)).trim()
    return { entry, name: entryName(entry, index), content, tokens: estimateTokens(content), source, reason }
  })
  // Бюджет: по умолчанию — в порядке промпта; с `priority` — сначала важные.
  const admitOrder = opts.priority ? [...items].sort((a, b) => priorityOf(b.entry) - priorityOf(a.entry)) : items
  const admitted = new Set<(typeof items)[number]>()
  let left = budget
  for (const item of admitOrder) {
    if (item.tokens > left) {
      const label = loreSourceLabel(item.source, item.name)
      out.dropped.push(label)
      out.droppedEntries.push({ label, name: item.name, source: item.source, tokens: item.tokens, reason: 'бюджет' })
      continue
    }
    left -= item.tokens
    admitted.add(item)
  }
  for (const item of items) {
    if (!admitted.has(item)) continue
    const deep = opts.depthPositions ? entryDepth(item.entry) : undefined
    const fired: FiredEntry = { name: item.name, content: item.content, position: deep ? 'at_depth' : entryPosition(item.entry), tokens: item.tokens, source: item.source, reason: item.reason }
    if (deep) {
      fired.depth = deep.depth
      fired.role = deep.role
      out.depth.push(fired)
    } else (fired.position === 'after_char' ? out.after : out.before).push(fired)
  }
  return out
}

/** Одна книга (бот) — обёртка над {@link selectLore}; бюджет — книги или дефолт. */
export function selectLorebook(book: Lorebook, messages: readonly string[], expand: (text: string) => string = (t) => t): LoreSelection {
  return selectLore([{ kind: 'bot', book }], messages, { expand })
}

/**
 * Сработала ли запись по тексту: окно истории, затем карточка (скан карточки).
 * Причина — какой ключ и где; `undefined` — нет. Вторичные ключи (AND при
 * `selective`) ищутся в окне вместе с карточкой.
 */
function triggered(entry: LorebookEntry, window: string, card: string | undefined, bookWhole: boolean | undefined): string | undefined {
  const opts = { caseSensitive: entry.case_sensitive === true, wholeWord: wholeWordOf(entry, bookWhole) }
  const keys = strings(entry.keys)
  let reason: string | undefined
  const inWindow = keys.find((k) => keyMatches(window, k, opts))
  if (inWindow !== undefined) reason = `ключ «${inWindow.trim()}»`
  else if (card !== undefined) {
    const inCard = keys.find((k) => keyMatches(card, k, opts))
    if (inCard !== undefined) reason = `карточка: ключ «${inCard.trim()}»`
  }
  if (reason === undefined) return undefined
  const secondary = strings(entry.secondary_keys)
  if (entry.selective === true && secondary.length > 0) {
    const text = card !== undefined ? `${window}\n${card}` : window
    const second = secondary.find((k) => keyMatches(text, k, opts))
    return second === undefined ? undefined : `${reason} + «${second.trim()}»`
  }
  return reason
}

/**
 * Слово целиком — только явным `match_whole_words: true` (запись: в
 * `extensions` или полем; иначе книга). `false`/`null`/нет — подстрокой.
 */
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

function priorityOf(entry: LorebookEntry): number {
  const p = entry.priority ?? extOf(entry).priority
  return typeof p === 'number' && Number.isFinite(p) ? p : 0
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
