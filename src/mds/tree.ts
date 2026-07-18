/**
 * mds-кодек — дерево диалога над nr-session-нодами (слито из nr-session, §3).
 *
 * Дерево живёт ссылками в мете (`{id, parent}`), линейный файл — вырожденный
 * случай без оверхеда. `parent` отсутствует → родитель = предыдущая обычная
 * нода (chain default). Ветка = сегмент файла: первая нода несёт явный `parent`,
 * дальше растёт chain default'ом. Свайпы — derived из siblings, отдельного
 * хранения нет.
 *
 * Это дерево над `SessionNode` (ленивый parent) — отдельно от tree-математики
 * ядра над `StoreNode` (явный parent, `../tree.js`).
 */

import type { Session, SessionNode } from './session.js'

/** Резолвнутое дерево: индексы родителей/детей поверх нод сессии. */
export interface Tree {
  /** Корни (в норме один — первая обычная нода файла, §3). */
  roots: SessionNode[]
  parentOf: Map<SessionNode, SessionNode | null>
  childrenOf: Map<SessionNode, SessionNode[]>
  byId: Map<string, SessionNode>
}

/** Позиция узла среди siblings — основа свайпов (§3, §5). */
export interface SwipeInfo {
  /** Индекс узла активного пути среди siblings. */
  active: number
  /** Число siblings (веток в этой точке). */
  count: number
  siblings: SessionNode[]
}

/**
 * Построить индекс дерева. `children(X)` = ноды с явным `parent == X.id`
 * плюс позиционный преемник X (следующая обычная нода без явного parent).
 * Порядок детей = порядок в файле.
 */
export function resolveTree(nodes: SessionNode[]): Tree {
  const byId = new Map<string, SessionNode>()
  for (const node of nodes) {
    if (node.id !== undefined) byId.set(node.id, node)
  }

  const parentOf = new Map<SessionNode, SessionNode | null>()
  const childrenOf = new Map<SessionNode, SessionNode[]>()
  const roots: SessionNode[] = []
  for (const node of nodes) childrenOf.set(node, [])

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    let parent: SessionNode | null = null

    if (node.parent !== undefined) {
      // Явный parent: ветка. Ссылка на несуществующий id → трактуем как корень
      // (битая ссылка не должна валить резолв).
      parent = byId.get(node.parent) ?? null
    } else if (i > 0) {
      // Chain default: родитель = предыдущая обычная нода.
      parent = nodes[i - 1]
    }

    parentOf.set(node, parent)
    if (parent) childrenOf.get(parent)!.push(node)
    else roots.push(node)
  }

  return { roots, parentOf, childrenOf, byId }
}

/**
 * Активный лист: `currNode` из хедера, если он резолвится в существующую ноду,
 * иначе последняя обычная нода файла (§2, §3).
 */
export function activeLeaf(session: Session, tree = resolveTree(session.nodes)): SessionNode | undefined {
  const curr = session.header?.meta.currNode
  if (typeof curr === 'string') {
    const node = tree.byId.get(curr)
    if (node) return node
  }
  return session.nodes[session.nodes.length - 1]
}

/**
 * Активный путь: от корня до активного листа по parent-ссылкам/позициям.
 * Это и есть `history()` протокола (§3). Порядок — хронологический (корень
 * первым).
 */
export function activePath(session: Session, tree = resolveTree(session.nodes)): SessionNode[] {
  const leaf = activeLeaf(session, tree)
  const path: SessionNode[] = []
  let cur: SessionNode | null | undefined = leaf
  const seen = new Set<SessionNode>()
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    path.push(cur)
    cur = tree.parentOf.get(cur) ?? null
  }
  return path.reverse()
}

/** Siblings узла = общие children его родителя (или корни, если родителя нет). */
export function siblingsOf(node: SessionNode, tree: Tree): SessionNode[] {
  const parent = tree.parentOf.get(node) ?? null
  return parent ? tree.childrenOf.get(parent)! : tree.roots
}

/**
 * Свайп-инфо узла (§3): его siblings, индекс среди них (`active`) и число
 * (`count`). `count > 1` — точка ветвления, где UI показывает свайпы.
 */
export function swipeInfo(node: SessionNode, tree: Tree): SwipeInfo {
  const siblings = siblingsOf(node, tree)
  return { active: siblings.indexOf(node), count: siblings.length, siblings }
}

/** Спуститься от узла к листу, следуя последнему ребёнку (самая свежая ветка). */
export function descendToLeaf(node: SessionNode, tree: Tree): SessionNode {
  let cur = node
  for (;;) {
    const children = tree.childrenOf.get(cur)!
    if (children.length === 0) return cur
    cur = children[children.length - 1]
  }
}
