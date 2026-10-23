/**
 * Лорбук v2 на ране (DEV-446): документ сессии → вход {@link selectLoreV2} и
 * раскладка выбора по ленте. Общий кусок `assembleRp` и билдера `mds-template`
 * — оба пути обязаны давать одну ленту (паритет, spec §8).
 */

import type { Message as DtoMessage, Persona, PersonasDoc } from '../model.js'
import { compactionData } from './engine.js'
import type { Lorebook } from './lorebook.js'
import {
  loreBooks,
  loreV2Label,
  loreV2Reason,
  selectLoreV2,
  type LoreDelivery,
  type LoreEmbedScores,
  type LoreFired,
  type LorePin,
  type LoreRole,
  type LoreScanMessage,
  type LoreV2Selection,
} from './lore-v2.js'

/** Мета реплики игрока: закрепления `sticky` и ротация `once` (§4–5). */
export const LORE_PINS_META = 'lore'
export const LORE_ONCE_META = 'loreOnce'
/** Источник предупреждения лорбука в инъекциях рана. */
export const LORE_WARNING_SOURCE = 'lorebook: предупреждение'
/** Префикс id синтетических сообщений лорбука. */
export const LORE_NODE_PREFIX = 'nr:lore2-'

/** Что хост дал лорбуку рана сверх книг профиля (всё необязательно). */
export interface RunLoreExtras {
  /** Пути книг профиля в порядке `books` (id и дедуп). */
  paths?: string[]
  /** `$lore_delivery`. */
  delivery?: LoreDelivery
  /** `$lore_role`. */
  role?: LoreRole
  /** Книги библиотеки сессии (`meta.lorebooks[].path`), прочитаны хостом. */
  library?: ReadonlyMap<string, Lorebook>
  /** Косинусы эмбедов и пороги, посчитанные хостом. */
  embed?: LoreEmbedScores
  /** Предупреждения (эмбеддер недоступен…). */
  warnings?: string[]
}

export interface RunLoreInput {
  meta: Record<string, unknown>
  doc: PersonasDoc
  user: Persona | undefined
  /** Путь сессии (после компакции). */
  path: readonly DtoMessage[]
  books: readonly Lorebook[]
  extras?: RunLoreExtras
  expand: (text: string) => string
  cardText?: string
  scanCard?: boolean
  impersonate?: boolean
  seed?: string
  budget?: number
}

/** Сообщения окна скана из пути: user/assistant, не компакция, с текстом; мета закреплений. */
export function scanMessages(path: readonly DtoMessage[]): LoreScanMessage[] {
  const out: LoreScanMessage[] = []
  for (const m of path) {
    if (compactionData(m) || (m.role !== 'user' && m.role !== 'assistant')) continue
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text?: string }).text ?? '')
      .join('\n')
    if (text.trim() === '') continue
    const meta = (m.meta ?? {}) as Record<string, unknown>
    const pins = pinsOf(meta[LORE_PINS_META])
    const once = pinsOf(meta[LORE_ONCE_META])
    out.push({ id: m.id, role: m.role, text, ...(pins.length ? { pins } : {}), ...(once.length ? { once } : {}) })
  }
  return out
}

export function pinsOf(v: unknown): LorePin[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
    .filter((p) => typeof p.book === 'string' && (typeof p.entry === 'string' || typeof p.entry === 'number'))
    .map((p) => ({ book: String(p.book), entry: String(p.entry), ...(typeof p.variant === 'number' ? { variant: p.variant } : {}) }))
}

/** Выбор лорбука рана; книг нет — `undefined`. */
export function runLore(input: RunLoreInput): LoreV2Selection | undefined {
  const x = input.extras ?? {}
  const userRec = input.user as (Persona & Record<string, unknown>) | undefined
  const books = loreBooks({
    metaLorebook: input.meta.lorebook,
    sessionBooks: input.meta.lorebooks,
    ...(x.library ? { resolved: x.library } : {}),
    chars: input.doc.personas.filter((p) => p.kind === 'char').map((p) => ({ id: p.id, card: p.card, lorebook: (p as unknown as Record<string, unknown>).lorebook })),
    ...(userRec ? { user: { id: userRec.id, card: userRec.card, lorebook: userRec.lorebook } } : {}),
    profile: input.books.map((book, i) => ({ book, ...(x.paths?.[i] ? { path: x.paths[i]! } : {}) })),
  })
  if (!books.length) return undefined
  return selectLoreV2({
    books,
    history: scanMessages(input.path),
    ...(x.delivery ? { delivery: x.delivery } : {}),
    ...(x.role ? { role: x.role } : {}),
    ...(x.embed ? { embed: x.embed } : {}),
    ...(x.warnings?.length ? { warnings: x.warnings } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    expand: input.expand,
    ...(input.cardText !== undefined ? { cardText: input.cardText } : {}),
    ...(input.scanCard ? { scanCard: true } : {}),
    ...(input.impersonate ? { impersonate: true } : {}),
    classic: { depthPositions: true, priority: true, ...(input.budget !== undefined ? { budget: input.budget } : {}) },
  })
}

/** Вставка лорбука в ленту: после якоря, сообщением system или текстом в реплику. */
export interface LoreInsert {
  /** id сообщения истории, после которого встаёт запись. */
  after: string
  fired: LoreFired
  source: string
  reason: string
  /** `user`: текстом в реплику-якорь (`[lore: имя]`), иначе отдельным system. */
  merge: boolean
}

/**
 * Вставки хода в порядке ленты: закреплённые — после своих реплик, `once` —
 * после последнего сообщения истории. `lastId` — id последнего сообщения истории.
 */
export function loreInserts(sel: LoreV2Selection | undefined, lastId: string | undefined): LoreInsert[] {
  if (!sel) return []
  const merge = sel.role === 'user'
  const out: LoreInsert[] = []
  for (const f of sel.sticky) if (f.anchor) out.push({ after: f.anchor, fired: f, source: loreV2Label(f), reason: loreV2Reason(f), merge })
  // `once` текстом в реплику — только если история кончается репликой игрока; иначе отдельным сообщением.
  const onceAfter = lastId
  if (onceAfter !== undefined) for (const f of sel.once) out.push({ after: onceAfter, fired: f, source: loreV2Label(f), reason: loreV2Reason(f), merge: merge && onceAfter === sel.anchor })
  return out
}

/** Текст записи, вписанной в реплику игрока (`$lore_role: user`). */
export function mergedLoreText(name: string, content: string): string {
  return `[lore: ${name}]\n${content}`
}

/** Инъекции рецепта лорбука v2 вне system: закреплённые, хвост, не прошедшие, предупреждения. */
export function loreDiagnostics(sel: LoreV2Selection | undefined): Array<{ role: 'system'; text: string; source: string; reason?: string }> {
  if (!sel) return []
  const out: Array<{ role: 'system'; text: string; source: string; reason?: string }> = []
  for (const w of sel.warnings) out.push({ role: 'system', text: w, source: LORE_WARNING_SOURCE })
  if (sel.missed.length) {
    out.push({
      role: 'system',
      text: sel.missed.map((m) => `${m.name} (${m.book}): балл ${m.score} — ${m.reason}`).join('\n'),
      source: `lorebook: не вошли ${sel.missed.length}`,
      reason: 'порог/лимит/группа',
    })
  }
  return out
}
