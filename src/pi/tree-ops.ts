/**
 * pi tree — mutation mechanics (spec §7.2).
 *
 * pi's active leaf is stored nowhere: it's the last line of the file. Hence —
 * switching a branch (swipe) means moving its subtree to the end of the file,
 * deleting nothing (`reorderToActivate`); making an entry the leaf without
 * touching its children — `moveToEnd` (regenerate-as-swipe).
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

/** Build a tree from entries in file order (children in file order). */
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

/** A node's branches: its parent's children (or the roots). */
export function siblingsOf(tree: PiTree, id: string): PiTreeNode[] {
  const node = tree.byId.get(id)
  if (!node) return []
  return node.parent ? node.parent.children : tree.roots
}

/** A node's subtree (the node itself first). */
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

/** Reorder entries so the leaf of branch `id` becomes the active leaf. */
export function reorderToActivate(entries: PiEntry[], tree: PiTree, id: string): PiEntry[] {
  const moved = subtreeIds(tree, id)
  if (moved.size === 0) return entries
  const rest = entries.filter((e) => !moved.has(e.id))
  const tail = entries.filter((e) => moved.has(e.id))
  return [...rest, ...tail]
}

/** Make an entry the last line (active leaf) WITHOUT touching its children. */
export function moveToEnd(entries: PiEntry[], id: string): PiEntry[] {
  const target = entries.find((e) => e.id === id)
  if (!target) return entries
  return [...entries.filter((e) => e.id !== id), target]
}
