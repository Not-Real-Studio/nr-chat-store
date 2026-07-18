/**
 * nr-chat codec §7 — branching: branchAt → id on the target (via pos:N), branch
 * at end of file with an explicit parent, siblings/swipes resolve, active path.
 * swipeTo: only the %meta span changes. append on a swiped branch. Tree math is
 * asserted through the projection (`toModel`) + the core.
 */

import { describe, it, expect } from 'vitest'
import { resolveTree, activePath, swipeInfo, type StoreNode } from '../src/index.js'
import {
  parseSession,
  toModel,
  toProtocol,
  branchAt,
  swipeTo,
  appendMessage,
  applyPatches,
} from '../src/nr-chat/index.js'

// text body of a projected store node
const body = (n: StoreNode): string | undefined => n.parts.find((p) => p.type === 'text')?.text
// active-path bodies through projection + core
const pathBodies = (text: string): (string | undefined)[] => activePath(toModel(parseSession(text))).map(body)

// детерминированный генератор id для тестов
function seqGen(prefix = 'g') {
  let n = 0
  return () => `${prefix}${++n}`
}

const WITH_ID = `%meta {id: 's1'}
%user Denis {id: 'u1'}
вопрос
%assistant
ответ A
`

describe('ветвление branchAt', () => {
  it('ветка дозаписью в конец с явным parent, старые байты не тронуты (append-only)', () => {
    const session = parseSession(WITH_ID)
    const patches = branchAt(session, 'u1', { role: 'assistant', body: 'ответ B' })

    // единственный патч — append (цель уже с id, currNode не трогаем)
    expect(patches).toHaveLength(1)
    expect(patches[0].kind).toBe('append')

    const next = applyPatches(session.text, patches)
    expect(next.startsWith(session.text)).toBe(true) // старые байты нетронуты
    expect(next.endsWith('ответ B\n')).toBe(true)
    expect(next).toContain("parent: 'u1'")
  })

  it('id появляется у цели при адресации по pos:N', () => {
    // линейный файл без id; ветвимся в точке pos:0 (первая нода)
    const linear = parseSession(`%meta {id: 's1'}\n%user Denis\nвопрос\n%assistant\nответ A\n`)
    const patches = branchAt(linear, 'pos:0', { role: 'assistant', body: 'ответ B' }, { genId: seqGen('t') })

    const next = applyPatches(linear.text, patches)
    // цели (user) проставлен id t1
    expect(next).toContain("%user Denis {id: 't1'}")
    // новая ветка ссылается на него
    expect(next).toContain("parent: 't1'")

    const s2 = parseSession(next)
    expect(s2.nodes[0].id).toBe('t1')
  })

  it('siblings/swipes резолвятся: два ответа = свайп count 2', () => {
    const session = parseSession(WITH_ID)
    const next = applyPatches(session.text, branchAt(session, 'u1', { role: 'assistant', body: 'ответ B' }))

    const tree = resolveTree(toModel(parseSession(next)).nodes)
    const u1 = tree.byId.get('u1')!
    const children = tree.childrenOf.get(u1)!
    expect(children.map(body)).toEqual(['ответ A', 'ответ B'])
    for (const c of children) expect(swipeInfo(c, tree).count).toBe(2)
  })

  it('активный путь идёт на свежую ветку (последняя нода = лист)', () => {
    const session = parseSession(WITH_ID)
    const next = applyPatches(session.text, branchAt(session, 'u1', { role: 'assistant', body: 'ответ B' }))

    const s2 = parseSession(next)
    // currNode не задан — активный лист = последняя нода = ответ B
    expect(s2.header?.meta.currNode).toBeUndefined()
    expect(pathBodies(next)).toEqual(['вопрос', 'ответ B'])

    const { messages } = toProtocol(s2)
    const last = messages[messages.length - 1]
    expect(last.parts).toEqual([{ type: 'text', text: 'ответ B' }])
    expect(last.swipes).toEqual({ active: 1, count: 2 })
  })
})

const TWO_BRANCHES = `%meta {id: 's1', currNode: 'a1'}
%user Denis {id: 'u1'}
вопрос
%assistant {id: 'a1'}
ответ A
%assistant {id: 'a2', parent: 'u1'}
ответ B
`

describe('свайп swipeTo', () => {
  it('меняется только спан %meta, остальные байты идентичны', () => {
    const session = parseSession(TWO_BRANCHES)
    // активна ветка A (currNode=a1); свайпаем на B (a2 — уже с id)
    const patches = swipeTo(session, 'a2')
    expect(patches).toHaveLength(1)
    expect(patches[0].kind).toBe('splice')

    const after = applyPatches(session.text, patches)
    const before = session.text.split('\n')
    const afterL = after.split('\n')
    expect(afterL.length).toBe(before.length)
    // всё кроме первой строки (%meta) — байт-в-байт
    for (let i = 1; i < before.length; i++) expect(afterL[i]).toBe(before[i])
    expect(afterL[0]).not.toBe(before[0])
    expect(parseSession(after).header?.meta.currNode).toBe('a2')
  })

  it('активный путь следует currNode', () => {
    const session = parseSession(TWO_BRANCHES)
    expect(pathBodies(TWO_BRANCHES)).toEqual(['вопрос', 'ответ A'])
    const after = applyPatches(session.text, swipeTo(session, 'a2'))
    expect(pathBodies(after)).toEqual(['вопрос', 'ответ B'])
  })

  it('swipeTo dir: next переключает между siblings', () => {
    const session = parseSession(TWO_BRANCHES)
    // активна A (индекс 0 среди [a1, a2]); next → B
    const after = applyPatches(session.text, swipeTo(session, { dir: 'next' }))
    expect(pathBodies(after)).toEqual(['вопрос', 'ответ B'])
  })
})

describe('append на свайпнутой ветке', () => {
  it('дозапись продолжает currNode-ветку явным parent, currNode снимается', () => {
    const session = parseSession(TWO_BRANCHES) // currNode=a1, последняя нода=a2
    const patches = appendMessage(session, { role: 'user', name: 'Denis', body: 'ещё вопрос' })
    const next = applyPatches(session.text, patches)
    const s2 = parseSession(next)

    const nodes = toModel(s2).nodes
    const tree = resolveTree(nodes)
    const appended = nodes[nodes.length - 1]
    expect(body(appended)).toBe('ещё вопрос')
    // висит на a1 (активный лист), не на a2 (последняя нода файла)
    expect(tree.parentOf.get(appended)?.id).toBe('a1')
    // currNode снят → активный лист = новая нода
    expect(s2.header?.meta.currNode).toBeUndefined()
    expect(pathBodies(next)).toEqual(['вопрос', 'ответ A', 'ещё вопрос'])
  })

  it('линейный append: ноль меты когда лист = последняя нода и нет currNode', () => {
    const src = `%user Denis\nпривет\n%assistant\nответ\n`
    const patches = appendMessage(parseSession(src), { role: 'user', name: 'Denis', body: 'ещё' })
    expect(patches).toHaveLength(1)
    expect(patches[0].kind).toBe('append')
    expect(applyPatches(src, patches)).toBe(`%user Denis\nпривет\n%assistant\nответ\n%user Denis\nещё\n`)
  })
})
