/**
 * Файл карточки `<сессия>.assets/card.mdz` (DEV-428 §2; шапка mdz — objects-spec §15.1 п.1, DEV-493):
 * шапка `$поле: значение` (кто, когда, чем сделана, с какой версии ленты) + markdown с разделами.
 * Старые `card.md` с фронтматтером читаются (`parseCard` понимает обе формы) и заменяются при
 * следующей записи. Якоря — ссылки
 * `#/s/<сессия>?m=<нода>`: во фронте открывают сессию и прокручивают к ноде.
 */

import type { CardItem, CardRecord, CardUsage } from './pipeline.js'

export const CARD_FILE = 'card.mdz'
/** Прежний файл карточки (фронтматтер): только чтение. */
export const LEGACY_CARD_FILE = 'card.md'

export const CARD_SECTIONS: ReadonlyArray<[keyof Pick<CardRecord, 'decided' | 'agent' | 'done' | 'open' | 'waiting'>, string]> = [
  ['decided', 'Решили'],
  ['agent', 'Решил агент'],
  ['done', 'Сделано'],
  ['open', 'Висит'],
  ['waiting', 'Ждёт Дениса'],
]

/** Шапка карточки — то, что читают сканер и сводка без разбора тела. */
export interface CardHead {
  session: string
  title: string
  about: string
  kind?: string
  workspace?: string
  project?: string
  first?: string
  last?: string
  /** `updatedAt` сессии, с которой снята карточка: сканер не перегенерирует без новых реплик. */
  source?: string
  generated?: string
  model?: string
  cost?: number
}

export interface CardDoc {
  head: CardHead
  /** Разделы: заголовок → строки (уже с якорями-ссылками). */
  sections: Record<string, string[]>
}

/** Ссылка на ноду сессии внутри nrchat. */
export const messageHref = (session: string, node: string): string => `#/s/${encodeURIComponent(session)}?m=${encodeURIComponent(node)}`
export const sessionHref = (session: string): string => `#/s/${encodeURIComponent(session)}`

const one = (s: string): string => s.replace(/\s+/g, ' ').trim()
const yamlStr = (s: string): string => JSON.stringify(one(s))

/** Подпись якоря — короткая (у ACP id ноды — UUID), адрес — полный. */
function line(session: string, it: CardItem): string {
  return `- ${one(it.text)} (${it.anchors.map((a) => `[#${a.slice(0, 6)}](${messageHref(session, a)})`).join(', ')})`
}

/** Запись → текст `card.mdz`. */
export function renderCard(
  rec: CardRecord,
  meta: { session: string; kind?: string; workspace?: string; project?: string; source?: string; model?: string; usage?: CardUsage; generated?: string },
): string {
  const head: string[] = [`$session: ${meta.session}`, `$title: ${yamlStr(rec.title)}`, `$about: ${yamlStr(rec.about)}`]
  if (meta.kind) head.push(`$kind: ${meta.kind}`)
  if (meta.workspace) head.push(`$workspace: ${meta.workspace}`)
  if (meta.project) head.push(`$project: ${meta.project}`)
  if (rec.first) head.push(`$first: ${rec.first}`)
  if (rec.last) head.push(`$last: ${rec.last}`)
  if (meta.source) head.push(`$source: ${meta.source}`)
  head.push(`$generated: ${meta.generated ?? new Date().toISOString()}`)
  if (meta.model) head.push(`$model: ${meta.model}`)
  if (meta.usage) head.push(`$cost: ${meta.usage.cost.toFixed(4)}`)
  head.push('', '')
  const body: string[] = [`# ${one(rec.title) || 'Чат'}`, '', one(rec.about), '']
  const dates = [rec.first?.slice(0, 16).replace('T', ' '), rec.last?.slice(0, 16).replace('T', ' ')].filter(Boolean)
  if (dates.length) body.push(`[Сессия](${sessionHref(meta.session)}) · ${dates.join(' — ')} · реплик ${rec.messages}`, '')
  for (const [key, name] of CARD_SECTIONS) {
    body.push(`## ${name}`)
    const items = rec[key]
    body.push(...(items.length ? items.map((it) => line(meta.session, it)) : ['—']), '')
  }
  return head.join('\n') + body.join('\n')
}

function unquote(v: string): string {
  const t = v.trim()
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string
    } catch {
      return t.slice(1, -1)
    }
  }
  return t
}

/** Текст `card.mdz` (шапка mdz) или старого `card.md` (фронтматтер) → шапка и разделы; не карточка — `null`. */
export function parseCard(text: string): CardDoc | null {
  const raw: Record<string, string> = {}
  let rest: string
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (fm) {
    for (const l of fm[1]!.split('\n')) {
      const kv = /^([a-z]+):\s?(.*)$/.exec(l)
      if (kv) raw[kv[1]!] = unquote(kv[2]!)
    }
    rest = fm[2]!
  } else {
    const lines = text.split('\n')
    let i = 0
    for (; i < lines.length; i++) {
      const kv = /^\$([a-z_]+):\s?(.*)$/.exec(lines[i]!)
      if (!kv) break
      raw[kv[1]!] = unquote(kv[2]!)
    }
    if (!i) return null
    rest = lines.slice(i).join('\n')
  }
  if (!raw.session) return null
  const head: CardHead = { session: raw.session, title: raw.title ?? '', about: raw.about ?? '' }
  for (const k of ['kind', 'workspace', 'project', 'first', 'last', 'source', 'generated', 'model'] as const) if (raw[k]) head[k] = raw[k]
  if (raw.cost && Number.isFinite(Number(raw.cost))) head.cost = Number(raw.cost)
  const sections: Record<string, string[]> = {}
  let cur: string[] | undefined
  for (const l of rest.split('\n')) {
    const h = /^## (.+)$/.exec(l)
    if (h) {
      cur = sections[h[1]!.trim()] = []
      continue
    }
    if (cur && l.startsWith('- ')) cur.push(l.slice(2))
  }
  return { head, sections }
}

/** Пункт раздела карточки (DEV-492 §5): текст без якорей, ноды-якоря, устойчивый ключ. */
export interface CardEntry {
  /** Раздел по-человечески: «Ждёт Дениса», «Висит»… */
  section: string
  text: string
  /** id нод (из `?m=` ссылок), по порядку. */
  anchors: string[]
  /** Хэш раздела и нормализованного текста: переписанная карточка с тем же пунктом — тот же ключ. */
  key: string
}

/** Нормализация текста пункта для ключа: регистр, пробелы, хвостовая пунктуация. */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').replace(/[.;,!\s]+$/u, '').trim()

/** FNV-1a 32 — без зависимостей, одинаково в браузере и Node. */
function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function cardEntryKey(section: string, text: string): string {
  return fnv(`${section}\n${norm(text)}`)
}

const ANCHOR_TAIL = /\s*\((\[#[^\]]*\]\([^)]*\)(?:,\s*)?)+\)\s*$/u

/** Пункты разделов карточки; `—` (пусто) — мимо. Без `sections` — все разделы. */
export function cardEntries(doc: CardDoc, sections?: readonly string[]): CardEntry[] {
  const out: CardEntry[] = []
  for (const [section, lines] of Object.entries(doc.sections)) {
    if (sections && !sections.includes(section)) continue
    for (const l of lines) {
      const tail = ANCHOR_TAIL.exec(l)
      const text = (tail ? l.slice(0, tail.index) : l).trim()
      if (!text || text === '—') continue
      const anchors = tail ? [...tail[0].matchAll(/\?m=([^)\s]+)\)/g)].map((m) => decodeURIComponent(m[1]!)) : []
      out.push({ section, text, anchors, key: cardEntryKey(section, text) })
    }
  }
  return out
}
