/**
 * @notreal/nr-chat-store — контракт драйвера хранилища (spec §5).
 *
 * Полностью асинхронный: драйвер может быть облачным (chub, opencode, dreams,
 * любой HTTP). Опциональный метод ↔ capability: read-only драйвер = только
 * list/load — легален. Набор мутаций — минимум, выведенный из messages-операций
 * протокола; ветвление/regenerate = `appendNode` с явным `parent` +
 * `setActiveLeaf`, отдельного примитива нет.
 *
 * Generation и process-management — вне контракта (не хранение).
 */

import type { Part, SessionInfo, SessionModel, StoreNode, NodeInput } from './model.js'

/**
 * Патч записи (spec §5). `text` — шорткат протокола §4.2: заменяется первый
 * text-part, остальные parts сохраняются. `ifHash` — обязательная детекция
 * конфликта: mismatch → ошибка `conflict`, молчаливая перезапись запрещена.
 */
export interface NodePatch {
  parts?: Part[]
  text?: string
  ifHash?: string
}

export interface SessionStore {
  capabilities(): Promise<StoreCapabilities>
  list(opts?: { limit?: number; cursor?: string }): Promise<{ sessions: SessionInfo[]; cursor?: string }>
  load(id: string): Promise<SessionModel>
  create(opts?: { id?: string; info?: Partial<SessionInfo> }): Promise<SessionInfo>
  delete?(id: string): Promise<void>
  /** Смена title сессии (примитив, отдельный от sessionMeta). capability: rename. */
  rename?(id: string, title: string): Promise<void>

  /** Дозапись узла. `parent` не задан → активный лист (§5). */
  appendNode(sid: string, node: NodeInput): Promise<StoreNode>
  editNode?(sid: string, nid: string, patch: NodePatch): Promise<StoreNode>
  /** Дети перецепляются на родителя удаляемого (§5). */
  deleteNode?(sid: string, nid: string): Promise<void>
  hideNode?(sid: string, nid: string, hidden: boolean): Promise<void>
  /** Swipe-примитив: сделать `nid` активным листом. */
  setActiveLeaf?(sid: string, nid: string): Promise<void>
  /** Новая сессия из активного пути (до `atNodeId` включительно). */
  forkCopy?(sid: string, atNodeId?: string): Promise<SessionInfo>

  meta?: {
    get(sid: string): Promise<Record<string, unknown>>
    patch(sid: string, p: Record<string, unknown>): Promise<void>
  }
  assets?: {
    put(sid: string, name: string, data: Uint8Array, mime?: string): Promise<{ ref: string }>
  }
  version?(sid: string): Promise<string>
  close?(): Promise<void>
}

/**
 * Заявленные возможности драйвера. Правило backends-spec §2 дословно:
 * опциональный метод присутствует ⟺ соответствующая capability истинна.
 */
export interface StoreCapabilities {
  edits?: { edit?: boolean; delete?: boolean; hide?: boolean }
  swipes?: boolean // = setActiveLeaf
  fork?: boolean // = forkCopy
  rename?: boolean // = rename (примитив смены title)
  assets?: boolean
  sessionMeta?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// Ошибки контракта
// ────────────────────────────────────────────────────────────────────────────

/**
 * Тело записи изменилось под правкой (`ifHash` не совпал). Код `conflict` —
 * нормативный: у локальных это optimistic concurrency против себя, у remote —
 * против чужих правок между load и editNode.
 */
export class StoreConflictError extends Error {
  readonly code = 'conflict'
  constructor(nid: string) {
    super(`chat-store: запись ${nid} изменилась — ifHash не совпал`)
    this.name = 'StoreConflictError'
  }
}

/** Адресована запись, которой в сессии нет. */
export class StoreNodeNotFound extends Error {
  readonly code = 'not_found'
  constructor(nid: string) {
    super(`chat-store: записи ${nid} нет в сессии`)
    this.name = 'StoreNodeNotFound'
  }
}

/** Запрошена сессия, которой нет в хранилище. */
export class StoreSessionNotFound extends Error {
  readonly code = 'not_found'
  constructor(sid: string) {
    super(`chat-store: сессии ${sid} нет в хранилище`)
    this.name = 'StoreSessionNotFound'
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Общее для драйверов
// ────────────────────────────────────────────────────────────────────────────

/** `NodeInput` → `Part[]`: полный набор либо text-шорткат (пустой → один text). */
export function partsOf(input: NodeInput): Part[] {
  if (input.parts) return input.parts
  return [{ type: 'text', text: input.text ?? '' }]
}

/**
 * Шорткат `text` патча (§5): заменить text-части одним text-part, остальные
 * сохранить. Нет ни одной text-части — новая уезжает в конец.
 */
export function replaceTextParts(parts: Part[], text: string): Part[] {
  const out: Part[] = []
  let placed = false
  for (const part of parts) {
    if (part.type !== 'text') {
      out.push(part)
      continue
    }
    if (!placed) {
      out.push({ type: 'text', text })
      placed = true
    }
  }
  if (!placed) out.push({ type: 'text', text })
  return out
}
