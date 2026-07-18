/**
 * Tree-математика — юниты над нейтральной моделью (spec §4, §8).
 */

import { describe, expect, it } from 'vitest'
import {
  activeLeaf,
  activePath,
  contentHash,
  descendToLeaf,
  resolveTree,
  siblingsOf,
  swipeInfo,
  toHistory,
  toThread,
  type SessionModel,
  type StoreNode,
} from '../src/index.js'

function node(id: string, parent: string | null, text: string, role = 'user'): StoreNode {
  return { id, parent, role, parts: [{ type: 'text', text }] }
}

function model(nodes: StoreNode[], activeLeafId?: string): SessionModel {
  const m: SessionModel = { info: { id: 's' }, nodes }
  if (activeLeafId) m.meta = { activeLeaf: activeLeafId }
  return m
}

describe('resolveTree', () => {
  it('строит roots/children/parent по явным ссылкам', () => {
    const nodes = [node('a', null, 'A'), node('b', 'a', 'B'), node('c', 'b', 'C')]
    const tree = resolveTree(nodes)
    expect(tree.roots.map((n) => n.id)).toEqual(['a'])
    expect(tree.childrenOf.get(tree.byId.get('a')!)!.map((n) => n.id)).toEqual(['b'])
  })

  it('битая parent-ссылка → корень, не крэш', () => {
    const nodes = [node('a', null, 'A'), node('b', 'zzz', 'B')]
    const tree = resolveTree(nodes)
    expect(tree.roots.map((n) => n.id).sort()).toEqual(['a', 'b'])
  })

  it('самородитель отсекается в корни', () => {
    const tree = resolveTree([node('a', 'a', 'A')])
    expect(tree.roots.map((n) => n.id)).toEqual(['a'])
  })
})

describe('activePath / activeLeaf', () => {
  it('activeLeaf = meta.activeLeaf если резолвится, иначе последняя нода', () => {
    const nodes = [node('a', null, 'A'), node('b', 'a', 'B'), node('c', 'a', 'C')]
    expect(activeLeaf(model(nodes))!.id).toBe('c') // последняя
    expect(activeLeaf(model(nodes, 'b'))!.id).toBe('b')
    expect(activeLeaf(model(nodes, 'нет'))!.id).toBe('c') // невалидный хинт → последняя
  })

  it('активный путь = корень→лист', () => {
    const nodes = [node('a', null, 'A'), node('b', 'a', 'B'), node('c', 'a', 'C')]
    expect(activePath(model(nodes, 'b')).map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('цикл не зацикливает activePath', () => {
    const nodes = [node('a', 'b', 'A'), node('b', 'a', 'B')]
    expect(() => activePath(model(nodes, 'a'))).not.toThrow()
  })
})

describe('siblings / swipes / descend', () => {
  const nodes = [node('a', null, 'A'), node('b', 'a', 'B'), node('c', 'a', 'C'), node('d', 'c', 'D')]
  const tree = resolveTree(nodes)

  it('siblingsOf = дети общего родителя', () => {
    expect(siblingsOf(tree.byId.get('b')!, tree).map((n) => n.id)).toEqual(['b', 'c'])
  })

  it('swipeInfo: active/count', () => {
    const info = swipeInfo(tree.byId.get('c')!, tree)
    expect(info).toMatchObject({ active: 1, count: 2 })
  })

  it('descendToLeaf идёт по последнему ребёнку', () => {
    expect(descendToLeaf(tree.byId.get('a')!, tree).id).toBe('d')
  })
})

describe('проекции', () => {
  const nodes = [node('a', null, 'A'), node('b', 'a', 'B'), node('c', 'a', 'C'), node('d', 'c', 'D')]

  it('toHistory = активный путь + свайпы на точках ветвления', () => {
    const hist = toHistory(model(nodes)) // лист = d
    expect(hist.map((m) => m.id)).toEqual(['a', 'c', 'd'])
    expect(hist.find((m) => m.id === 'c')!.swipes).toEqual({ active: 1, count: 2 })
    expect(hist.find((m) => m.id === 'a')!.swipes).toBeUndefined()
  })

  it('toThread = обход целиком с глубиной (DFS)', () => {
    const thread = toThread(model(nodes))
    expect(thread.map((t) => [t.message.id, t.depth])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 1],
      ['d', 2],
    ])
  })
})

describe('contentHash', () => {
  it('детерминирован по роли + parts', () => {
    const parts = [{ type: 'text' as const, text: 'x' }]
    expect(contentHash('user', parts)).toBe(contentHash('user', parts))
  })
  it('меняется с телом, не с ролью-однобайтно', () => {
    expect(contentHash('user', [{ type: 'text', text: 'a' }])).not.toBe(
      contentHash('user', [{ type: 'text', text: 'b' }]),
    )
    expect(contentHash('user', [{ type: 'text', text: 'a' }])).not.toBe(
      contentHash('assistant', [{ type: 'text', text: 'a' }]),
    )
  })
})
