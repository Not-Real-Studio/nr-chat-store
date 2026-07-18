/**
 * mds-кодек — модель сессии над mds (слито из nr-session, §2–4).
 *
 * `parseSession` разбирает mds-поток (через @notrealstudio/nr-chat) и навешивает
 * сессионные конвенции поверх формата, не меняя его: `%meta`-хедер (§2),
 * дерево `{id, parent}` в мете (§3), `%%`-суб-ноды как части сообщения (§4).
 * Грамматика nr-chat не интерпретируется заново — parse/stringify/replaceSpan
 * работают как есть, здесь только слой смысла.
 *
 * Канон кодека: S:\skills\nr-system.dev\specs\nr-session-spec.md (кодек живёт
 * в nr-chat-store/mds после слияния NOT-274).
 */

import { parse } from '@notrealstudio/nr-chat'
import type { ChatMessageWithSpan, Span } from '@notrealstudio/nr-chat'

/** Роль `%meta`-хедера (§2). Зарезервирована nr-chat-spec §2.3. */
export const META_ROLE = 'meta'

/**
 * Суб-нода `%%` (§4): роль в потоке начинается с `%` (маркер `%%xxx` →
 * роль `%xxx` по грамматике nr-chat). Часть ближайшей обычной ноды выше,
 * ровно один уровень. В дереве не участвует, id/parent не несёт.
 */
export interface SubNode {
  /** Роль как её видит nr-chat: `%thinking`, `%tool_use`, … (с ведущим `%`). */
  rawRole: string
  /** Ключ словаря ядра: `thinking`, `tool_use`, … (без ведущего `%`). */
  kind: string
  name?: string
  meta?: Record<string, unknown>
  body: string
  message: ChatMessageWithSpan
}

/**
 * Обычная нода сессии (§3): узел дерева диалога с прикреплёнными суб-нодами.
 * `id`/`parent` — ленивые (§3): присутствуют только там, где нужны.
 */
export interface SessionNode {
  /** Позиция среди обычных нод файла (0-based). Основа `pos:N` id (§5). */
  index: number
  role: string
  name?: string
  meta?: Record<string, unknown>
  /** Тело обычной ноды = первый text-part (всё до первой суб-ноды, §4). */
  body: string
  /** Явный id из меты (§3). Отсутствует у нод, на которые не ссылаются. */
  id?: string
  /** Явный parent из меты (§3). Отсутствует → chain default (пред. нода). */
  parent?: string
  subNodes: SubNode[]
  /** Спан самой обычной ноды (маркер + тело), без суб-нод. */
  message: ChatMessageWithSpan
  /** Спан всей группы: обычная нода + её суб-ноды. */
  span: Span
}

/** `%meta`-хедер сессии (§2). В LLM не отдаётся; body — свободная зона. */
export interface SessionHeader {
  /** Обязательный id сессии (§2), если задан. */
  id?: string
  name?: string
  /** Разобранная мета хедера (открытый словарь, round-trip сохраняется). */
  meta: Record<string, unknown>
  body: string
  /** `%%`-суб-ноды хедера (§2): структурный стейт сессии → sessionMeta. */
  subNodes: SubNode[]
  message: ChatMessageWithSpan
  span: Span
}

/**
 * Разобранная сессия: хедер (если есть) + обычные ноды с суб-нодами.
 * `text` — исходные байты, база для хирургии по спанам (§6).
 */
export interface Session {
  text: string
  header?: SessionHeader
  nodes: SessionNode[]
}

/** Роль-суб-нода: маркер `%%…`, т.е. роль с ведущим `%` (§4). */
function isSubRole(role: string): boolean {
  return role.startsWith('%')
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/**
 * Разобрать mds-поток в сессию. Конвенции навешиваются поверх nr-chat:
 * первая нода с ролью `meta` — хедер; роли на `%` — суб-ноды ближайшей
 * обычной ноды выше; остальное — обычные ноды дерева.
 *
 * Файл без `%meta` — легальный поток, но не сессия: `header` будет `undefined`,
 * tree-функции работают, сессионная проекция даёт минимальный SessionInfo (§2).
 *
 * @throws {SyntaxError} пробрасывается из nr-chat при невалидной JSON5-мете.
 */
export function parseSession(text: string): Session {
  const messages = parse(text, { spans: true })
  const nodes: SessionNode[] = []
  let header: SessionHeader | undefined
  let current: SessionNode | undefined

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    // Хедер: роль `meta` первой нодой файла. `meta` дальше по потоку —
    // чекпоинт (§8.1, v2): трактуем как обычную ноду, ядро не блокирует.
    if (msg.role === META_ROLE && header === undefined && nodes.length === 0 && current === undefined) {
      header = {
        id: asString(msg.meta?.id),
        name: msg.name,
        meta: msg.meta ?? {},
        body: msg.body,
        subNodes: [],
        message: msg,
        span: msg.span,
      }
      continue
    }

    if (isSubRole(msg.role)) {
      // Суб-нода прикрепляется к ближайшей обычной ноде выше; до первой
      // обычной ноды носитель — `%meta`-хедер (§2: структурный стейт →
      // sessionMeta). Сирота без хедера не имеет носителя — игнорируем.
      if (!current && !header) continue
      const sub: SubNode = {
        rawRole: msg.role,
        kind: msg.role.slice(1),
        name: msg.name,
        meta: msg.meta,
        body: msg.body,
        message: msg,
      }
      if (current) {
        current.subNodes.push(sub)
        current.span = { start: current.span.start, end: msg.span.end }
      } else if (header) {
        header.subNodes.push(sub)
        header.span = { start: header.span.start, end: msg.span.end }
      }
      continue
    }

    // Обычная нода — новый узел дерева.
    current = {
      index: nodes.length,
      role: msg.role,
      name: msg.name,
      meta: msg.meta,
      body: msg.body,
      id: asString(msg.meta?.id),
      parent: asString(msg.meta?.parent),
      subNodes: [],
      message: msg,
      span: { start: msg.span.start, end: msg.span.end },
    }
    nodes.push(current)
  }

  return { text, header, nodes }
}
