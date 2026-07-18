/**
 * @notreal/chat-store — tree-математика над нейтральной моделью (spec §4).
 *
 * Дерево не принадлежит mds: pi-кодек, claude-транскрипты и nr-session
 * реализовывали одну и ту же математику по третьему разу — здесь она живёт один
 * раз, обобщённая на `StoreNode` (parent всегда явный). Чистая, zero-dep.
 *
 * Две проекции одного дерева:
 *   - `toHistory` — активный путь + свайпы; ветки = альтернативы (диалог);
 *   - `toThread`  — обход целиком (DFS, глубина на узле); ветки живут все (треды).
 */

import type { Message, MessageFlags, MessageMeta, Part, SessionModel, StoreNode, Usage } from './model.js'

/** Резолвнутое дерево: индексы родителей/детей поверх нод. */
export interface Tree {
  /** Корни в порядке появления (в норме один). */
  roots: StoreNode[]
  parentOf: Map<StoreNode, StoreNode | null>
  childrenOf: Map<StoreNode, StoreNode[]>
  byId: Map<string, StoreNode>
}

/** Позиция узла среди siblings — основа свайпов. */
export interface SwipeInfo {
  /** Индекс узла среди siblings. */
  active: number
  /** Число siblings (веток в этой точке). */
  count: number
  siblings: StoreNode[]
}

/**
 * Построить индекс дерева. `parent` явный: резолвится по `byId`. Ссылка на
 * несуществующий id → узел трактуется как корень (битая ссылка не валит резолв,
 * §4). Порядок детей = append-порядок нод.
 */
export function resolveTree(nodes: StoreNode[]): Tree {
  const byId = new Map<string, StoreNode>()
  for (const node of nodes) byId.set(node.id, node)

  const parentOf = new Map<StoreNode, StoreNode | null>()
  const childrenOf = new Map<StoreNode, StoreNode[]>()
  const roots: StoreNode[] = []
  for (const node of nodes) childrenOf.set(node, [])

  for (const node of nodes) {
    // `parent === node.id` (самородитель) отсекаем в корни, как и висячую ссылку.
    const parent = node.parent != null && node.parent !== node.id ? byId.get(node.parent) ?? null : null
    parentOf.set(node, parent)
    if (parent) childrenOf.get(parent)!.push(node)
    else roots.push(node)
  }

  return { roots, parentOf, childrenOf, byId }
}

/**
 * Активный лист: `meta.activeLeaf` из модели, если резолвится в существующую
 * ноду, иначе последняя нода хранилища (§4). Конвенция «нет activeLeaf → лист =
 * последняя нода» — общая для драйверов (mds currNode, pi «последняя строка»).
 */
export function activeLeaf(model: SessionModel, tree = resolveTree(model.nodes)): StoreNode | undefined {
  const hint = model.meta?.activeLeaf
  if (typeof hint === 'string') {
    const node = tree.byId.get(hint)
    if (node) return node
  }
  return model.nodes[model.nodes.length - 1]
}

/**
 * Активный путь: от корня до активного листа по parent-ссылкам. Это `history()`
 * протокола для любого драйвера бесплатно. Порядок — хронологический (корень
 * первым). Циклы отсекаются.
 */
export function activePath(model: SessionModel, tree = resolveTree(model.nodes)): StoreNode[] {
  const leaf = activeLeaf(model, tree)
  const path: StoreNode[] = []
  let cur: StoreNode | null | undefined = leaf
  const seen = new Set<StoreNode>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    path.push(cur)
    cur = tree.parentOf.get(cur) ?? null
  }
  return path.reverse()
}

/** Siblings узла = общие children его родителя (или корни, если родителя нет). */
export function siblingsOf(node: StoreNode, tree: Tree): StoreNode[] {
  const parent = tree.parentOf.get(node) ?? null
  return parent ? tree.childrenOf.get(parent)! : tree.roots
}

/**
 * Свайп-инфо узла: siblings, индекс среди них (`active`), число (`count`).
 * `count > 1` — точка ветвления, где UI показывает свайпы.
 */
export function swipeInfo(node: StoreNode, tree: Tree): SwipeInfo {
  const siblings = siblingsOf(node, tree)
  return { active: siblings.indexOf(node), count: siblings.length, siblings }
}

/** Спуститься от узла к листу, следуя последнему ребёнку (самая свежая ветка). */
export function descendToLeaf(node: StoreNode, tree: Tree): StoreNode {
  let cur = node
  const seen = new Set<StoreNode>()
  for (;;) {
    if (seen.has(cur)) return cur
    seen.add(cur)
    const children = tree.childrenOf.get(cur)!
    if (children.length === 0) return cur
    cur = children[children.length - 1]
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Проекции (§4)
// ────────────────────────────────────────────────────────────────────────────

function bool(v: unknown): boolean | undefined {
  return v === true ? true : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** Флаги сообщения из меты ноды — известные ключи как есть. */
function flagsOf(meta: Record<string, unknown> | undefined, own: MessageFlags | undefined): MessageFlags | undefined {
  const flags: MessageFlags = { ...(own ?? {}) }
  if (meta) {
    if (bool(meta.hidden)) flags.hidden = true
    if (bool(meta.frozen)) flags.frozen = true
    if (bool(meta.injected)) flags.injected = true
  }
  return Object.keys(flags).length ? flags : undefined
}

/** `model`/`usage`/`createdAt` из меты ноды → `Message.meta`. */
function metaOf(meta: Record<string, unknown> | undefined): MessageMeta | undefined {
  if (!meta) return undefined
  const out: MessageMeta = {}
  const createdAt = str(meta.createdAt)
  const model = str(meta.model)
  if (createdAt !== undefined) out.createdAt = createdAt
  if (model !== undefined) out.model = model
  if (meta.usage && typeof meta.usage === 'object') out.usage = meta.usage as Usage
  return Object.keys(out).length ? out : undefined
}

/**
 * Узел → `Message`. `swipes` навешиваются только там, где веток больше одной;
 * `hash` — контентный (роль + parts), для optimistic concurrency edit.
 */
export function nodeToMessage(node: StoreNode, tree: Tree): Message {
  const message: Message = { id: node.id, role: node.role, parts: node.parts }
  if (node.name !== undefined) message.name = node.name

  const flags = flagsOf(node.meta, node.flags)
  if (flags) message.flags = flags

  const meta = metaOf(node.meta)
  if (meta) message.meta = meta

  const info = swipeInfo(node, tree)
  if (info.count > 1) message.swipes = { active: info.active, count: info.count }

  message.hash = contentHash(node.role, node.parts)
  return message
}

/**
 * `history()` протокола: активный путь → `Message[]`, ветки = альтернативы.
 * Порядок — от корня к листу.
 */
export function toHistory(model: SessionModel, tree = resolveTree(model.nodes)): Message[] {
  return activePath(model, tree).map((node) => nodeToMessage(node, tree))
}

/** Узел треда: сообщение + его глубина в дереве (корень = 0). */
export interface ThreadNode {
  message: Message
  depth: number
}

/**
 * Обход дерева целиком (DFS, prefix), ветки = соседи (живут все) — проекция для
 * тредов (reddit/discord/комментарии). Порядок детей — append-порядок. Протокол
 * v1 треды не рендерит; это легально — он один клиент модели из N (§4).
 */
export function toThread(model: SessionModel, tree = resolveTree(model.nodes)): ThreadNode[] {
  const out: ThreadNode[] = []
  const seen = new Set<StoreNode>()
  const walk = (node: StoreNode, depth: number): void => {
    if (seen.has(node)) return
    seen.add(node)
    out.push({ message: nodeToMessage(node, tree), depth })
    for (const child of tree.childrenOf.get(node)!) walk(child, depth + 1)
  }
  for (const root of tree.roots) walk(root, 0)
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Контентный хеш (optimistic concurrency)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Хеш тела сообщения: роль + parts. Считается по телу, а не по узлу целиком —
 * `ifHash` защищает от правки поверх чужой правки, а не от смены parent/времени:
 * свайп/перенос ветки хеш не двигают, правка текста двигает.
 *
 * FNV-1a 32-бит (zero-dep, детерминированный, кросс-платформенный): коллизии
 * тут не критичны — это детекция изменения, не крипто-подпись.
 */
export function contentHash(role: string, parts: Part[]): string {
  const canonical = JSON.stringify({ role, parts })
  let h = 0x811c9dc5
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
