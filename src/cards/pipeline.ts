/**
 * Карточка чата (DEV-428 §2): лента сессии → эпизоды → факты с якорем → запись
 * «Решили / Решил агент / Сделано / Висит / Ждёт Дениса» + заголовок и «о чём».
 *
 * Перенос раннера раскопок `nrs/runs/digs/digs.mdz` (сегментация, извлечение,
 * правила статусов, дедуп) и пробы `nrs/runs/session-probe/record.mdz`. Сети здесь
 * нет: модель зовёт вызывающий (`complete` — гейт стенда); всё остальное —
 * чистые функции над `Message[]` активного пути. Якорь — id ноды ленты.
 */

import type { Message } from '../model.js'
import { PROMPT_EXT, PROMPT_RECORD, PROMPT_SEG } from './prompts.js'

/** Реплика чата для разметки: номер для модели, id ноды для якоря. */
export interface CardMessage {
  /** Номер для модели (1…). */
  i: number
  /** id ноды ленты — якорь карточки. */
  id: string
  role: 'user' | 'assistant'
  time: string
  text: string
  hint?: string
}

/** Вызов модели: system + user → текст. Стоимость считает вызывающий (`cost`). */
export type CardComplete = (req: { system: string; user: string; maxTokens: number; temperature: number }) => Promise<{
  text: string
  finish?: string
  inTok?: number
  outTok?: number
  cost?: number
}>

export interface CardItem {
  text: string
  /** id нод ленты. */
  anchors: string[]
}

export interface CardRecord {
  title: string
  about: string
  decided: CardItem[]
  agent: CardItem[]
  done: CardItem[]
  open: CardItem[]
  waiting: CardItem[]
  /** Первая и последняя реплика (ISO). */
  first?: string
  last?: string
  /** Сколько реплик ушло в разметку. */
  messages: number
}

export interface CardUsage {
  calls: number
  inTok: number
  outTok: number
  cost: number
}

export interface BuildCardOpts {
  complete: CardComplete
  /** Маска секретов в тексте перед отправкой (ключи, токены). */
  mask?: (text: string) => string
  /** Окно сегментации, символов (больше — эпизоды по окнам). */
  windowChars?: number
  /** Чат короче — без сегментации, один эпизод. */
  singleEpisodeChars?: number
  /** Параллельных извлечений. */
  parallel?: number
}

// ── лента → реплики ──────────────────────────────────────────────────────────

const AI_VOICE =
  /(^|\n)\s*(я (сделал|сделала|проверил|проверила|записал|записала|завёл|завел|поправил|поправила|добавил|добавила|прогнал|прогнала)\b|моя ошибка|ошибка была моя|готово[:.]|тесты? \d+\s*\/\s*\d+|typecheck|коммит [0-9a-f]{7}|commit [0-9a-f]{7})/im

function hint(role: 'user' | 'assistant', text: string): string {
  if (role === 'assistant') return /^\s*(что уже решено|прочитал handoff|контекст из handoff|где мы|напомню, что решено)/i.test(text.slice(0, 300)) ? 'пересказ' : ''
  const L = text.length
  const code = (text.match(/```[\s\S]*?```/g) ?? []).reduce((a, x) => a + x.length, 0)
  if (L > 8000) return 'вставка'
  if (L > 400 && code > 0.3 * L) return 'вставка?'
  if (L > 400 && AI_VOICE.test(text)) return 'вставка?'
  if (L > 2500) return 'вставка?'
  return ''
}

/**
 * Активный путь ленты → реплики: только текст user/assistant; тулы, рассуждения,
 * вложения, выключенные ноды — мимо. Подряд идущие ответы ассистента (ход CC — много
 * нод) склеиваются, якорь — первая нода хода.
 */
export function cardMessages(messages: readonly Message[], opts: { mask?: (s: string) => string } = {}): CardMessage[] {
  const out: CardMessage[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (m.flags?.disabled || m.flags?.visible === false) continue
    let text = m.parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    if (!text) continue
    if (opts.mask) text = opts.mask(text)
    const time = typeof (m.meta as { createdAt?: unknown } | undefined)?.createdAt === 'string' ? ((m.meta as { createdAt: string }).createdAt) : ''
    const last = out.at(-1)
    if (m.role === 'assistant' && last?.role === 'assistant') {
      last.text += '\n\n' + text
      continue
    }
    out.push({ i: out.length + 1, id: m.id, role: m.role, time, text })
  }
  for (const m of out) m.hint = hint(m.role, m.text)
  return out
}

const fmtTime = (iso: string): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '')

function render(list: readonly CardMessage[], ctxIds: ReadonlySet<number> = new Set()): string {
  return list
    .map((m) => `--- #${m.i} · ${m.role === 'user' ? 'Денис' : 'Ассистент'} · ${fmtTime(m.time)}${m.hint ? ' · ' + m.hint : ''}${ctxIds.has(m.i) ? ' · контекст' : ''}\n${m.text}`)
    .join('\n\n')
}

// ── JSON модели ──────────────────────────────────────────────────────────────

/** JSON из ответа модели: снимает ограду, чинит висячие запятые и незакрытые скобки. */
export function parseModelJson(text: string): Record<string, unknown> | null {
  const s = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0) return null
  const body = b > a ? s.slice(a, b + 1) : s.slice(a)
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    /* чиним */
  }
  return repairJson(s.slice(a)) ?? repairJson(body)
}

/** Оборванный ответ: висячие запятые, незакрытые строка и скобки. */
function repairJson(src: string): Record<string, unknown> | null {
  let fixed = src.replace(/,\s*([\]}])/g, '$1')
  const stack: string[] = []
  let inStr = false
  for (let k = 0; k < fixed.length; k++) {
    const ch = fixed[k]!
    if (inStr) {
      if (ch === '\\') k++
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  if (inStr) fixed += '"'
  if (stack.length) fixed = fixed.replace(/,\s*$/, '') + stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('')
  try {
    return JSON.parse(fixed) as Record<string, unknown>
  } catch {
    return null
  }
}

// ── правила статусов (раскопки v2) ──────────────────────────────────────────

/** Короткое согласие Дениса. */
const AFF = /^\s*(да|ага|угу|ок|окей|ok|okay|давай|давайте|поехали|го|годится|согласен|согласна|пиши|делай|делаем|запускай|бери|супер|отлично|принимаю|принято|ну можно|можно|норм|хорошо|вперёд|вперед|yes|👍|\+)/i
const STATUS_RANK: Record<string, number> = { decision: 5, delegated: 4, verified: 3, report: 2, proposal: 1 }
const KEY_RE = /\b([A-Z]{2,6})-(\d{1,5})\b/g

export interface CardFact {
  text: string
  status: 'decision' | 'delegated' | 'verified' | 'report' | 'proposal'
  by: 'denis' | 'assistant' | 'agent'
  src: string
  anchor: number
  of: number | null
  supersedes: string | null
}

interface Episode {
  title: string
  project: string
  artifact: string
  keys: string[]
  ranges: Array<[number, number]>
}

interface EpisodeFacts extends Episode {
  facts: CardFact[]
  open: Array<{ text: string; anchor: number }>
  wait: Array<{ text: string; anchor: number }>
}

/**
 * Факт модели → факт с исправленным статусом (правила раскопок): автор — по роли
 * сообщения якоря; из вставки решения не бывает; решение ассистента — только если
 * Денис следом коротко согласился (якорь — согласие); `verified` без следа проверки — `report`.
 */
export function fixFact(raw: Record<string, unknown>, msgs: readonly CardMessage[]): CardFact | null {
  const anchor = raw.anchor
  if (!Number.isInteger(anchor) || typeof raw.text !== 'string' || !raw.text.trim()) return null
  const am = msgs[(anchor as number) - 1]
  if (!am) return null
  const f: CardFact = {
    text: raw.text.trim(),
    status: (STATUS_RANK[String(raw.status)] ? raw.status : 'report') as CardFact['status'],
    by: (['denis', 'assistant', 'agent'].includes(String(raw.by)) ? raw.by : am.role === 'user' ? 'denis' : 'assistant') as CardFact['by'],
    src: typeof raw.src === 'string' ? raw.src : 'speech',
    anchor: anchor as number,
    of: Number.isInteger(raw.of) ? (raw.of as number) : null,
    supersedes: typeof raw.supersedes === 'string' && raw.supersedes ? raw.supersedes : null,
  }
  if (am.role === 'assistant' && f.by === 'denis') f.by = 'assistant'
  if (am.role === 'user' && f.by === 'assistant') f.by = 'denis'
  if (f.src.startsWith('paste') && f.by === 'denis') f.by = 'agent'
  if (f.src === 'recap') f.status = 'report'
  if (f.status === 'decision' && f.by !== 'denis') {
    const next = msgs.slice(f.anchor, f.anchor + 2).find((x) => x.role === 'user')
    if (next && next.text.length < 400 && AFF.test(next.text) && f.by !== 'agent') {
      f.of = f.of ?? f.anchor
      f.anchor = next.i
      f.by = 'denis'
    } else f.status = f.by === 'agent' ? 'report' : 'proposal'
  }
  if (f.status === 'delegated' && f.by === 'denis') f.status = 'decision'
  if (f.status === 'delegated' && f.by === 'agent') f.status = 'report'
  if (f.status === 'verified' && f.by !== 'denis' && !/\b[0-9a-f]{7,40}\b|\d+\s*\/\s*\d+|тест|прогон|passed|✓|✅/i.test(f.text)) f.status = 'report'
  return f
}

const words = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  )
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (!a.size || !b.size) return 0
  let n = 0
  for (const x of a) if (b.has(x)) n++
  return n / (a.size + b.size - n)
}

/** Дубли фактов между эпизодами: один на (якорь, похожий текст), статус — старший. */
export function dedupFacts(facts: CardFact[]): CardFact[] {
  const keep: Array<{ f: CardFact; w: Set<string> }> = []
  for (const f of facts) {
    const w = words(f.text)
    const twin = keep.find((k) => k.f.anchor === f.anchor && jaccard(k.w, w) >= 0.6)
    if (!twin) keep.push({ f, w })
    else if ((STATUS_RANK[f.status] ?? 0) > (STATUS_RANK[twin.f.status] ?? 0)) twin.f = f
  }
  return keep.map((k) => k.f)
}

// ── пайплайн ─────────────────────────────────────────────────────────────────

async function callJson(o: BuildCardOpts, usage: CardUsage, system: string, user: string, maxTokens: number): Promise<Record<string, unknown> | null> {
  let mt = maxTokens
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await o.complete({ system, user, maxTokens: mt, temperature: attempt ? 0 : 0.2 })
    usage.calls++
    usage.inTok += r.inTok ?? 0
    usage.outTok += r.outTok ?? 0
    usage.cost += r.cost ?? 0
    const p = parseModelJson(r.text)
    if (p) return p
    if (r.finish === 'length') mt = Math.min(mt * 2, 64000)
  }
  return null
}

function rangesOf(raw: unknown, n: number): Array<[number, number]> {
  if (!Array.isArray(raw)) return []
  const out: Array<[number, number]> = []
  for (const x of raw) {
    if (!Array.isArray(x) || !Number.isInteger(x[0]) || !Number.isInteger(x[1])) continue
    const a = Math.max(1, Math.min(x[0] as number, x[1] as number))
    const b = Math.min(n, Math.max(x[0] as number, x[1] as number))
    if (a <= b) out.push([a, b])
  }
  return out
}

async function segment(msgs: CardMessage[], o: BuildCardOpts, usage: CardUsage): Promise<Episode[]> {
  const total = msgs.reduce((a, m) => a + m.text.length, 0)
  const whole: Episode = { title: 'чат', project: '', artifact: 'chat', keys: [], ranges: [[1, msgs.length]] }
  if (total <= (o.singleEpisodeChars ?? 40000)) return [whole]
  const W = o.windowChars ?? 300000
  const windows: CardMessage[][] = []
  let cur: CardMessage[] = []
  let size = 0
  for (const m of msgs) {
    if (size + m.text.length > W && cur.length) {
      windows.push(cur)
      cur = cur.slice(-10)
      size = cur.reduce((a, x) => a + x.text.length, 0)
    }
    cur.push(m)
    size += m.text.length
  }
  if (cur.length) windows.push(cur)
  const eps = new Map<string, Episode>()
  for (const w of windows) {
    const p = await callJson(o, usage, PROMPT_SEG, 'ЛОГ ЧАТА:\n\n' + render(w), 32000)
    const list = Array.isArray(p?.episodes) ? (p!.episodes as Array<Record<string, unknown>>) : []
    const wText = w.map((m) => m.text).join('\n').toUpperCase()
    for (const e of list) {
      const ranges = rangesOf(e?.ranges, msgs.length)
      if (!ranges.length) continue
      const keys = [...new Set((Array.isArray(e.keys) ? e.keys : []).map((k) => String(k).toUpperCase()).filter((k) => /^[A-Z]{2,6}-\d+$/.test(k) && wText.includes(k)))]
      const project = String(e.project ?? '').toLowerCase()
      const artifact = String(e.artifact ?? '').replace(KEY_RE, '').replace(/^[-_\s/]+|[-_\s/]+$/g, '').toLowerCase() || String(e.title ?? '').toLowerCase().slice(0, 40)
      const key = keys.length ? `${project}|${keys.sort().join(',')}` : `${project}|${artifact}`
      const ep = eps.get(key) ?? { title: String(e.title ?? artifact), project, artifact, keys, ranges: [] }
      ep.ranges.push(...ranges)
      eps.set(key, ep)
    }
  }
  if (!eps.size) return [whole]
  const out = [...eps.values()]
  // Ни одного сообщения вне эпизодов: к соседу, иначе — в «прочее».
  const covered = new Map<number, Set<number>>()
  out.forEach((ep, k) => {
    for (const [a, b] of ep.ranges) for (let i = a; i <= b; i++) (covered.get(i) ?? covered.set(i, new Set()).get(i)!).add(k)
  })
  let misc: Episode | undefined
  for (const m of msgs) {
    if (covered.has(m.i)) continue
    const nb = covered.get(m.i - 1) ?? covered.get(m.i + 1)
    if (nb?.size) {
      for (const k of nb) out[k]!.ranges.push([m.i, m.i])
      covered.set(m.i, new Set(nb))
    } else {
      if (!misc) {
        misc = { title: 'прочее', project: 'other', artifact: 'misc', keys: [], ranges: [] }
        out.push(misc)
      }
      misc.ranges.push([m.i, m.i])
      covered.set(m.i, new Set([out.length - 1]))
    }
  }
  return out
}

async function extract(ep: Episode, msgs: CardMessage[], o: BuildCardOpts, usage: CardUsage): Promise<EpisodeFacts> {
  const ids = new Set<number>()
  for (const [a, b] of ep.ranges) for (let i = a; i <= b; i++) ids.add(i)
  const base: EpisodeFacts = { ...ep, facts: [], open: [], wait: [] }
  if (ep.project === 'recap' || ep.project === 'life' || !ids.size) return base
  // Контекст согласия: следующая реплика Дениса после ответа ассистента из среза.
  const ctxIds = new Set<number>()
  for (const i of ids) {
    const m = msgs[i - 1]
    const nx = msgs[i]
    if (m?.role === 'assistant' && nx?.role === 'user' && !ids.has(nx.i)) ctxIds.add(nx.i)
  }
  const view = msgs.filter((m) => ids.has(m.i) || ctxIds.has(m.i))
  const head = `ЭПИЗОД: ${ep.title}${ep.project ? ` · проект ${ep.project}` : ''} · артефакт ${ep.artifact}${ep.keys.length ? ' · задачи ' + ep.keys.join(', ') : ''}`
  const p = await callJson(o, usage, PROMPT_EXT, `${head}\n\nФРАГМЕНТ ЛОГА:\n\n${render(view, ctxIds)}`, 12000)
  for (const raw of Array.isArray(p?.facts) ? (p!.facts as Array<Record<string, unknown>>) : []) {
    const a = raw?.anchor as number
    if (!ids.has(a) && !(ctxIds.has(a) && raw.status === 'decision')) continue
    const f = fixFact(raw, msgs)
    if (f) base.facts.push(f)
  }
  const anchored = (v: unknown): Array<{ text: string; anchor: number }> =>
    (Array.isArray(v) ? v : []).filter((x): x is { text: string; anchor: number } => !!x && typeof x.text === 'string' && Number.isInteger(x.anchor) && ids.has(x.anchor))
  base.open = anchored(p?.open)
  base.wait = anchored(p?.wait)
  return base
}

function recordInput(msgs: CardMessage[], eps: EpisodeFacts[], title: string | undefined): string {
  const lines = [`ЧАТ: ${title ?? '(без названия)'} (${msgs[0]?.time.slice(0, 10) ?? ''} — ${msgs.at(-1)?.time.slice(0, 10) ?? ''}), сообщений ${msgs.length}`]
  eps.forEach((e, k) => {
    lines.push(`\n### Эпизод ${k + 1}: ${e.title} [${e.artifact}]${e.keys.length ? ' ' + e.keys.join(', ') : ''}`)
    for (const f of [...e.facts].sort((a, b) => a.anchor - b.anchor)) lines.push(`- ${f.status}/${f.by}/${f.src} #${f.anchor}${f.supersedes ? ` отменяет: ${f.supersedes}` : ''} — ${f.text}`)
    for (const x of e.open) lines.push(`- open #${x.anchor} — ${x.text}`)
    for (const x of e.wait) lines.push(`- wait #${x.anchor} — ${x.text}`)
  })
  // Хвост чата целиком — модель видит, чем кончилось (закрыто ли висящее).
  const tail = msgs.slice(-4).map((m) => ({ ...m, text: m.text.slice(0, 1500) }))
  lines.push('\n### Конец чата (для состояния на конец)\n' + render(tail))
  return lines.join('\n')
}

function itemsOf(v: unknown, msgs: readonly CardMessage[]): CardItem[] {
  const out: CardItem[] = []
  for (const x of Array.isArray(v) ? v : []) {
    if (!x || typeof (x as { text?: unknown }).text !== 'string') continue
    const nums = (Array.isArray((x as { anchors?: unknown }).anchors) ? (x as { anchors: unknown[] }).anchors : [(x as { anchor?: unknown }).anchor]).filter((n): n is number => Number.isInteger(n))
    const anchors = [...new Set(nums.map((n) => msgs[n - 1]?.id).filter((id): id is string => !!id))]
    if (!anchors.length) continue
    out.push({ text: (x as { text: string }).text.trim(), anchors })
  }
  return out
}

/**
 * Карточка чата целиком. Пустой чат (нет реплик) — `null`. Короткий чат — без
 * сегментации (один эпизод). Ошибки модели не роняют: пустые разделы.
 */
export async function buildCard(messages: readonly Message[], opts: BuildCardOpts & { title?: string }): Promise<{ record: CardRecord; usage: CardUsage } | null> {
  const msgs = cardMessages(messages, opts.mask ? { mask: opts.mask } : {})
  if (!msgs.length) return null
  const usage: CardUsage = { calls: 0, inTok: 0, outTok: 0, cost: 0 }
  const eps = await segment(msgs, opts, usage)
  const results: EpisodeFacts[] = new Array(eps.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const k = next++
      if (k >= eps.length) return
      results[k] = await extract(eps[k]!, msgs, opts, usage)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.parallel ?? 3) }, worker))
  const all = dedupFacts(results.flatMap((r) => r.facts))
  const kept = new Set(all)
  for (const r of results) r.facts = r.facts.filter((f) => kept.has(f))
  const p = await callJson(opts, usage, PROMPT_RECORD, recordInput(msgs, results, opts.title), 8000)
  const record: CardRecord = {
    title: typeof p?.title === 'string' ? p.title.trim().slice(0, 80) : '',
    about: typeof p?.about === 'string' ? p.about.trim() : '',
    decided: itemsOf(p?.decided, msgs),
    agent: itemsOf(p?.agent, msgs),
    done: itemsOf(p?.done, msgs),
    open: itemsOf(p?.open, msgs),
    waiting: itemsOf(p?.waiting, msgs),
    messages: msgs.length,
    ...(msgs[0]?.time ? { first: msgs[0].time } : {}),
    ...(msgs.at(-1)?.time ? { last: msgs.at(-1)!.time } : {}),
  }
  return { record, usage }
}
