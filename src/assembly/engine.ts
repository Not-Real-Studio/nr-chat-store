/**
 * assembly/engine — форма `ContextEngine` (backend-nr-spec §5) и узел компакции.
 *
 * Форма — по образцу context engine OpenClaw (`openclaw-donor.md` §4):
 * `assemble` перед каждым вызовом модели, `afterTurn` после хода (рецепт,
 * индексы), `compact` — сжатие истории в summary, `ingest` — на будущее (RAG).
 * Реализации живут у бэкендов (backend-nr: plain-сборка + компакция); здесь —
 * только типы и чистые функции над моделью, без IO и провода. Сообщение — тип
 * модели пакета, тип сообщения провайдера — параметр (`M`).
 *
 * Узел компакции — запись `compaction` pi (её пишет и читает pi, pi-драйвер
 * отдаёт её узлом `role: 'system'` с custom-частью `hint: 'pi.compaction'`):
 * `{summary, firstKeptEntryId, tokensBefore, details?, fromHook?}`. Видимое
 * модели после компакции — как `buildContextEntries` pi: summary, затем
 * сообщения пути от `firstKeptEntryId` до узла компакции, затем всё после.
 */

import type { Message, Part, StoreNode } from '../model.js'
import type { Step } from './contract.js'

// ────────────────────────────────────────────────────────────────────────────
// ContextEngine — форма (§5)
// ────────────────────────────────────────────────────────────────────────────

/** Бюджет контекста модели рана. */
export interface ContextBudget {
  /** Окно модели, токены. */
  contextWindow: number
  /** Запас под ответ и summary: компакция, когда контекст > окно − запас. */
  reserveTokens: number
}

export interface AssembleRequest<Tool = unknown> {
  sessionId: string
  /** Активный путь (корень → лист), с id из стора; узлы компакции — как есть. */
  messages: Message[]
  /** Мета сессии (`nr-session-meta`). */
  meta?: Record<string, unknown>
  /** Профиль сессии документом. */
  profile?: unknown
  /** System профиля — база, к которой сборка добавляет свои секции. */
  system?: string
  /** Кто отвечает (impersonate, участник группы) — v2. */
  target?: unknown
  tools?: Tool[]
  budget?: ContextBudget
  signal?: AbortSignal
}

export interface AssembleResult<M = Message> {
  system: string
  /** Сообщения провайдеру — после компакции, ремонта пар и прочих шагов. */
  messages: M[]
  /** Оценка токенов: system + сообщения (+ тулы, если сборка их считала). */
  estimatedTokens: number
  /** id сообщений стора, вошедших в контекст (база рецепта). */
  messageIds: string[]
  /** Граница компакции, которую применила сборка. */
  compaction?: { id: string; firstKeptEntryId: string }
  /** Рецепт (prompt-recipe-spec) — пишется в `afterTurn`. */
  recipe?: unknown
}

export interface TurnResult {
  sessionId: string
  /** id записанных ответов хода. */
  messageIds: string[]
  recipe?: unknown
}

export type CompactReason = 'threshold' | 'manual' | 'overflow'

export interface CompactRequest {
  sessionId: string
  /** Активный путь, как в `assemble`. */
  messages: Message[]
  reason: CompactReason
  /** Фокус резюме (`/compact <фокус>`). */
  focus?: string
  budget?: ContextBudget
  signal?: AbortSignal
}

/** Готовая компакция — тело узла `compaction` (+ что сообщить о ней). */
export interface CompactResult extends CompactionData {
  /** Оценка контекста после (summary + хвост). */
  tokensAfter?: number
  /** Usage вызовов резюме. */
  usage?: { input: number; output: number }
}

/**
 * Движок сборки контекста. `assemble` — перед каждым вызовом модели;
 * `compact` — `undefined`, если сжимать нечего.
 */
export interface ContextEngine<M = Message, Tool = unknown> {
  assemble(req: AssembleRequest<Tool>): Promise<AssembleResult<M>>
  afterTurn?(res: TurnResult): Promise<void>
  compact?(req: CompactRequest): Promise<CompactResult | undefined>
  ingest?(message: Message): Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// Узел компакции
// ────────────────────────────────────────────────────────────────────────────

/** `meta.hint` custom-части узла компакции (тип записи pi с префиксом `pi.`). */
export const COMPACTION_HINT = 'pi.compaction'

/** Тело записи `compaction` pi. */
export interface CompactionData {
  summary: string
  /** id первой записи пути, оставшейся в контексте. */
  firstKeptEntryId: string
  tokensBefore: number
  /** У pi — `{readFiles, modifiedFiles}`; читается как есть. */
  details?: unknown
  fromHook?: boolean
}

type Carrier = Pick<Message, 'role' | 'parts'>

/** Данные компакции узла/сообщения; не узел компакции — `undefined`. */
export function compactionData(node: Carrier): CompactionData | undefined {
  for (const part of node.parts) {
    if (part.type !== 'custom' || part.meta?.hint !== COMPACTION_HINT) continue
    const data = part.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
    const d = data as Record<string, unknown>
    const summary = typeof d.summary === 'string' ? d.summary : typeof part.text === 'string' ? part.text : undefined
    if (summary === undefined || typeof d.firstKeptEntryId !== 'string') continue
    const out: CompactionData = { summary, firstKeptEntryId: d.firstKeptEntryId, tokensBefore: typeof d.tokensBefore === 'number' ? d.tokensBefore : 0 }
    if (d.details !== undefined) out.details = d.details
    if (d.fromHook === true) out.fromHook = true
    return out
  }
  return undefined
}

/** Часть узла компакции — так её отдаёт pi-драйвер (text = summary, data = тело записи). */
export function compactionPart(data: CompactionData): Part {
  const body: Record<string, unknown> = { summary: data.summary, firstKeptEntryId: data.firstKeptEntryId, tokensBefore: data.tokensBefore }
  if (data.details !== undefined) body.details = data.details
  if (data.fromHook) body.fromHook = true
  return { type: 'custom', text: data.summary, data: body, meta: { hint: COMPACTION_HINT } }
}

export interface CompactedView<T> {
  /** Видимое модели: [узел компакции, хвост от firstKept…, всё после]; без компакции — путь как есть. */
  items: T[]
  /** Последняя компакция пути. */
  compaction?: { index: number; item: T; data: CompactionData }
}

/**
 * Путь после компакции — семантика `buildContextEntries` pi: берётся ПОСЛЕДНИЙ
 * узел компакции пути; до него остаются записи с `firstKeptEntryId` (нет такой
 * на пути — ничего), после — всё. Узел компакции идёт первым: его заменит
 * summary-сообщение кодировщика провайдера.
 */
export function compactedView<T extends Carrier & { id: string }>(path: readonly T[]): CompactedView<T> {
  let index = -1
  let data: CompactionData | undefined
  for (let i = path.length - 1; i >= 0; i--) {
    const d = compactionData(path[i]!)
    if (d) {
      index = i
      data = d
      break
    }
  }
  if (index < 0 || !data) return { items: [...path] }
  const item = path[index]!
  const kept: T[] = []
  let found = false
  for (let i = 0; i < index; i++) {
    if (path[i]!.id === data.firstKeptEntryId) found = true
    if (found) kept.push(path[i]!)
  }
  return { items: [item, ...kept, ...path.slice(index + 1)], compaction: { index, item, data } }
}

/** Шаг сборки: линейка (активный путь) → видимое модели после компакции. */
export const applyCompaction: Step = (nodes: StoreNode[]) => compactedView(nodes).items
