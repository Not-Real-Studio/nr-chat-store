/**
 * CYOA (cyoa-spec, DEV-454): мета вариантов хода и заметок редактора, выбор
 * заметок в хвост хода, направление и тон impersonate.
 *
 * Мета живёт на сообщениях (лог книги = лента):
 *   ответ бота — `meta.choices` (варианты, `picked`), `meta.editorNotes` (0–2 строки);
 *   реплика игрока — `meta.direction` (по какому намерению написана),
 *   `meta.editorApplied` (какие заметки поданы в ход этой реплики).
 *
 * Выбор заметок детерминирован (как `loreOnce`, DEV-446): заметки последних двух
 * ответов бота на пути, которых ещё нет в `editorApplied` реплик пути. Своя
 * реплика (якорь) не считается — перегенерация хода подаёт те же заметки снова.
 */

import type { Message as DtoMessage } from '../model.js'

/** Ось варианта (повтор протокола: стор протокол не импортирует). */
export type ChoiceAxis = 'cautious' | 'bold' | 'social' | 'offscript'
export const CHOICE_AXES: readonly ChoiceAxis[] = ['cautious', 'bold', 'social', 'offscript']

/** Вариант хода: кнопка, намерение (не реплика и не исход), ось. */
export interface Choice {
  label: string
  intent: string
  axis: ChoiceAxis
  explicit?: boolean
}

/** `meta.choices` ответа бота. */
export interface ChoicesMeta {
  choices: Choice[]
  /** Какой выбрала бы модель (`auto.pick: model`). */
  pick?: number
  /** Какой выбран — ставится при отправке реплики с этим направлением. */
  picked?: number
  /** Варианты прошлых Re-roll этого ответа — в анти-повтор следующему. */
  previous?: Choice[]
  model?: string
}

/** `meta.direction` реплики игрока — `RunStartInput.direction` протокола. */
export interface DirectionMeta {
  intent: string
  axis?: ChoiceAxis
  tone?: string[]
  length?: 'short' | 'normal' | 'long'
  choice?: { messageId: string; index: number }
}

/** Отметка поданной заметки: ответ-источник и индекс в его `editorNotes`. */
export interface EditorApplied {
  from: string
  i: number
}

export const CHOICES_META = 'choices'
export const DIRECTION_META = 'direction'
export const EDITOR_NOTES_META = 'editorNotes'
export const EDITOR_APPLIED_META = 'editorApplied'

/** Источник вставки заметок в рецепте. */
export const EDITOR_SOURCE = 'editor'

/** Сколько последних ответов бота дают заметки в ход. */
export const EDITOR_WINDOW = 2

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/** Заметки ответа: строки, пустые выкинуты. */
export function editorNotesOf(m: Pick<DtoMessage, 'meta'> | undefined): string[] {
  const v = rec(m?.meta)?.[EDITOR_NOTES_META]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Отметки поданных заметок реплики. */
export function editorAppliedOf(m: Pick<DtoMessage, 'meta'> | undefined): EditorApplied[] {
  const v = rec(m?.meta)?.[EDITOR_APPLIED_META]
  if (!Array.isArray(v)) return []
  return v.filter((x): x is EditorApplied => !!rec(x) && typeof (x as EditorApplied).from === 'string' && Number.isInteger((x as EditorApplied).i))
}

/** Варианты ответа бота; битая мета — `undefined`. */
export function choicesOf(m: Pick<DtoMessage, 'meta'> | undefined): ChoicesMeta | undefined {
  const v = rec(rec(m?.meta)?.[CHOICES_META])
  if (!v || !Array.isArray(v.choices)) return undefined
  return v as unknown as ChoicesMeta
}

/** Заметка хода: откуда, индекс и текст. */
export interface TurnEditorNote extends EditorApplied {
  text: string
}

/** Что редактор подаёт в этот ход: якорь (реплика игрока хода) и заметки. */
export interface TurnEditorNotes {
  anchor?: string
  notes: TurnEditorNote[]
}

/**
 * Заметки хода по пути. Якорь — последнее сообщение пути, если это реплика игрока
 * (ход без реплики заметок не берёт: отметить подачу негде). Impersonate заметок
 * не берёт — решает вызывающий.
 */
export function editorNotesForTurn(path: readonly DtoMessage[]): TurnEditorNotes {
  const last = path.at(-1)
  if (!last || last.role !== 'user') return { notes: [] }
  const applied = new Set<string>()
  for (const m of path) {
    if (m === last || m.role !== 'user') continue
    for (const a of editorAppliedOf(m)) applied.add(`${a.from}#${a.i}`)
  }
  const bots: DtoMessage[] = []
  for (let i = path.length - 2; i >= 0 && bots.length < EDITOR_WINDOW; i--) if (path[i]!.role === 'assistant') bots.unshift(path[i]!)
  const notes: TurnEditorNote[] = []
  for (const b of bots) {
    editorNotesOf(b).forEach((text, i) => {
      if (text.trim() === '' || applied.has(`${b.id}#${i}`)) return
      notes.push({ from: b.id, i, text: text.trim() })
    })
  }
  return { anchor: last.id, notes }
}

/** Текст вставки заметок: одним блоком, важное первым (порядок редактора). */
export function editorNotesText(notes: readonly TurnEditorNote[]): string {
  if (!notes.length) return ''
  return `[Editor notes for this reply — follow them quietly, do not mention them]\n${notes.map((n) => `- ${n.text}`).join('\n')}`
}

// ────────────────────────────────────────────────────────────────────────────
// Направление impersonate
// ────────────────────────────────────────────────────────────────────────────

const LENGTH_TEXT: Record<string, string> = {
  short: 'short — one or two sentences',
  normal: '',
  long: 'expanded — a full, detailed reply',
}

/** Строки шаблона impersonate из направления: `{{direction}}`, `{{tone}}`, `{{length}}`. */
export function directionMacros(d: DirectionMeta | undefined): { direction: string; tone: string; length: string } {
  const tone = (d?.tone ?? []).map((t) => t.trim()).filter(Boolean).join(', ')
  return {
    direction: d?.intent?.trim() ?? '',
    tone,
    length: d?.length ? LENGTH_TEXT[d.length] ?? '' : '',
  }
}

/** Направление из сырого входа (провод, мета): битое — `undefined`. */
export function directionOf(v: unknown): DirectionMeta | undefined {
  const r = rec(v)
  if (!r || typeof r.intent !== 'string' || r.intent.trim() === '') return undefined
  const out: DirectionMeta = { intent: r.intent.trim() }
  if (typeof r.axis === 'string' && (CHOICE_AXES as readonly string[]).includes(r.axis)) out.axis = r.axis as ChoiceAxis
  if (Array.isArray(r.tone)) {
    const tone = r.tone.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    if (tone.length) out.tone = tone
  }
  if (r.length === 'short' || r.length === 'normal' || r.length === 'long') out.length = r.length
  const c = rec(r.choice)
  if (c && typeof c.messageId === 'string' && Number.isInteger(c.index)) out.choice = { messageId: c.messageId, index: c.index as number }
  return out
}
