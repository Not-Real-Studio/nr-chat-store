/**
 * @notreal/nr-chat-store — нейтральная модель чат-сессии (spec §3).
 *
 * Анатомия сообщения (Part/Message/SessionInfo/…) переехала сюда из
 * nr-ui-protocol §2.1–2.3 **как есть**, без правок семантики: это общая
 * реальность хранения и провода, дом ей — нижний слой. Протокол теперь клиент:
 * импортирует эти типы и ре-экспортирует (существующие импорты не ломаются),
 * себе оставляя wire (RunEvent, Capabilities, Envelope, SSE).
 *
 * Канон: S:\skills\nr-system.dev\specs\chat-store-spec.md
 */

// ────────────────────────────────────────────────────────────────────────────
// Session (протокол §2.1)
// ────────────────────────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string
  title?: string
  createdAt?: string // ISO
  updatedAt?: string // ISO
  messageCount?: number
  // презентация (capability: catalog)
  botId?: string
  botName?: string
  botAvatar?: string // URL/ref
  accentColor?: string
  participants?: Participant[]
  // ветвление (capability: fork)
  parentSessionId?: string
  forkMessageId?: string
}

export interface Participant {
  id: string
  type: 'human' | 'ai'
  name: string
  avatar?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Message (протокол §2.2)
// ────────────────────────────────────────────────────────────────────────────

export interface MessageFlags {
  hidden?: boolean // видно в UI, невидимо LLM
  frozen?: boolean // всегда в контексте
  injected?: boolean // вставлено системой, не показывается в ленте
}

export interface MessageMeta {
  createdAt?: string
  model?: string
  usage?: Usage
}

export interface Message {
  id: string // opaque handle; драйвер может отдавать позиционный ('pos:N')
  role: string // 'user' | 'assistant' | 'system' | 'tool' | 'narrator' | ...
  name?: string // отображаемое имя (group chat)
  parts: Part[] // первичное содержимое
  flags?: MessageFlags
  swipes?: { active: number; count: number } // capability: swipes
  hash?: string // optimistic concurrency для edit
  meta?: MessageMeta
}

export interface Usage {
  input: number
  output: number
}

// ────────────────────────────────────────────────────────────────────────────
// Part — закрытое ядро типов + escape hatch (custom) (протокол §2.3)
// ────────────────────────────────────────────────────────────────────────────

export interface TextPart {
  type: 'text'
  text: string
}

export interface ThinkingPart {
  type: 'thinking'
  text: string
  meta?: { signature?: string }
}

export interface ToolUsePart {
  type: 'tool_use'
  data: unknown
  meta: { callId: string; name: string }
}

export interface ToolResultPart {
  type: 'tool_result'
  data?: unknown
  text?: string
  meta: { callId: string; name?: string; error?: boolean }
}

export interface FilePart {
  type: 'file'
  meta: { name: string; mime?: string; url?: string; ref?: string }
}

export interface ImagePart {
  type: 'image'
  meta: { mime?: string; url?: string; ref?: string; alt?: string }
}

export interface ErrorPart {
  type: 'error'
  text: string
  meta?: { code?: string }
}

export interface CustomPart {
  type: 'custom'
  data?: unknown
  text?: string
  meta: { hint: string; [k: string]: unknown } // hint — подсказка рендереру
}

/** Закрытое ядро типов part. `custom` — escape hatch (закрытость сохраняется). */
export type Part =
  | TextPart
  | ThinkingPart
  | ToolUsePart
  | ToolResultPart
  | FilePart
  | ImagePart
  | ErrorPart
  | CustomPart

/** Литеральные значения `type` для известных part (для guards). */
export type KnownPartType = Part['type']

/**
 * Escape hatch: неизвестный тип part. Приезжает при graceful degradation —
 * рендерится fallback'ом, клиент не падает. Известные поля не гарантированы,
 * кроме `type`.
 */
export interface UnknownPart {
  type: string
  [k: string]: unknown
}

/** Любой part: известный либо opaque. */
export type AnyPart = Part | UnknownPart

// ────────────────────────────────────────────────────────────────────────────
// Сессионная структура (spec §3)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Нейтральная сессия: инфо + открытая мета + ноды в append-порядке хранилища.
 * `nodes` — всё дерево целиком, не активный путь: проекции (`toHistory`,
 * `toThread`) выбирают из него нужный срез (§4).
 */
export interface SessionModel {
  info: SessionInfo // id обязателен
  meta?: Record<string, unknown> // sessionMeta (открытый словарь)
  nodes: StoreNode[] // append-порядок хранилища
}

/**
 * Узел хранилища (spec §3). **Parent всегда явный** — общий знаменатель.
 * Chain default («нет parent = предыдущая нода») и прочие шорткаты кодирования
 * живут у драйверов: они разворачивают их при load и сворачивают при записи.
 */
export interface StoreNode {
  /**
   * Стабильный в рамках сессии id. Драйвер без родных id выдаёт позиционные
   * (`pos:N`).
   */
  id: string
  /** ЯВНЫЙ. `null` = корень. Битая ссылка трактуется как корень (§4). */
  parent: string | null
  role: string
  name?: string
  parts: Part[]
  flags?: MessageFlags
  /** Включая model/usage/createdAt и драйверо-специфику. */
  meta?: Record<string, unknown>
}

/**
 * Вход мутаций записи (spec §5): части (или text-шорткат), роль, явный parent.
 * `parent` не задан → драйвер цепляет к активному листу.
 */
export interface NodeInput {
  role: string
  name?: string
  /** Части сообщения. Взаимоисключающе с `text`. */
  parts?: Part[]
  /** Ярлык для одиночного text-part. */
  text?: string
  /** Явный parent. Не задан → активный лист; `null` → новый корень. */
  parent?: string | null
  flags?: MessageFlags
  meta?: Record<string, unknown>
}
