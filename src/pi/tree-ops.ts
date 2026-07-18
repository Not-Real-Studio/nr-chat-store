/**
 * pi-дерево — механика мутаций (spec §7.2).
 *
 * Активный лист pi нигде не хранится: это последняя строка файла. Отсюда —
 * переключить ветку (свайп) можно, переставив её поддерево в конец файла,
 * ничего не удаляя (`reorderToActivate`); сделать запись листом, не трогая её
 * детей — `moveToEnd` (regenerate-as-swipe).
 */

import type { PiEntry } from './format.js'

export interface PiTreeNode {
  entry: PiEntry
  parent: PiTreeNode | null
  children: PiTreeNode[]
}
export interface PiTree {
  byId: Map<string, PiTreeNode>
  roots: PiTreeNode[]
  leafId: string | null
}

/** Построить дерево из записей в порядке файла (дети — в порядке файла). */
export function buildTree(entries: PiEntry[]): PiTree {
  const byId = new Map<string, PiTreeNode>()
  for (const entry of entries) byId.set(entry.id, { entry, parent: null, children: [] })
  const roots: PiTreeNode[] = []
  for (const entry of entries) {
    const node = byId.get(entry.id)!
    const parentId = entry.parentId
    const parent = parentId != null && parentId !== entry.id ? byId.get(parentId) : undefined
    if (parent) {
      parent.children.push(node)
      node.parent = parent
    } else {
      roots.push(node)
    }
  }
  return { byId, roots, leafId: entries.length ? entries[entries.length - 1].id : null }
}

/** Ветки узла: дети его родителя (или корни). */
export function siblingsOf(tree: PiTree, id: string): PiTreeNode[] {
  const node = tree.byId.get(id)
  if (!node) return []
  return node.parent ? node.parent.children : tree.roots
}

/** Поддерево узла (сам узел первым). */
export function subtreeIds(tree: PiTree, id: string): Set<string> {
  const out = new Set<string>()
  const node = tree.byId.get(id)
  if (!node) return out
  const stack = [node]
  while (stack.length) {
    const cur = stack.pop()!
    out.add(cur.entry.id)
    for (const child of cur.children) stack.push(child)
  }
  return out
}

/** Переставить записи так, чтобы активным листом стал лист ветки `id`. */
export function reorderToActivate(entries: PiEntry[], tree: PiTree, id: string): PiEntry[] {
  const moved = subtreeIds(tree, id)
  if (moved.size === 0) return entries
  const rest = entries.filter((e) => !moved.has(e.id))
  const tail = entries.filter((e) => moved.has(e.id))
  return [...rest, ...tail]
}

/** Сделать запись последней строкой (активным листом), НЕ трогая её детей. */
export function moveToEnd(entries: PiEntry[], id: string): PiEntry[] {
  const target = entries.find((e) => e.id === id)
  if (!target) return entries
  return [...entries.filter((e) => e.id !== id), target]
}
