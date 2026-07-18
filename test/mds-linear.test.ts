/**
 * mds-кодек §7 — линейный файл без единой меты: chain, путь, проекция, ноль
 * оверхеда, round-trip. Совместимость: существующие линейные mds парсятся как есть.
 * Перенос тестов nr-session (NOT-274).
 */

import { describe, it, expect } from 'vitest'
import { parse, stringify } from '@notrealstudio/nr-chat'
import { parseSession, resolveTree, activePath, toProtocol } from '../src/mds/index.js'

const LINEAR = `%user Denis
привет
%assistant
здравствуй
%user Denis
как дела
%assistant
отлично
`

describe('линейный файл без единой меты', () => {
  it('chain default: каждая нода — ребёнок предыдущей, один корень', () => {
    const session = parseSession(LINEAR)
    const tree = resolveTree(session.nodes)

    expect(session.header).toBeUndefined()
    expect(session.nodes).toHaveLength(4)
    expect(tree.roots).toHaveLength(1)
    expect(tree.roots[0]).toBe(session.nodes[0])

    // parent каждой ноды — предыдущая
    for (let i = 1; i < session.nodes.length; i++) {
      expect(tree.parentOf.get(session.nodes[i])).toBe(session.nodes[i - 1])
    }
  })

  it('активный путь = весь файл (лист = последняя нода)', () => {
    const session = parseSession(LINEAR)
    const path = activePath(session)
    expect(path).toEqual(session.nodes)
  })

  it('ноль оверхеда: ни id, ни parent в мете', () => {
    const session = parseSession(LINEAR)
    for (const node of session.nodes) {
      expect(node.id).toBeUndefined()
      expect(node.parent).toBeUndefined()
    }
  })

  it('проекция: 4 сообщения, id — позиционные pos:N, без свайпов', () => {
    const { messages, session } = toProtocol(parseSession(LINEAR))
    expect(messages).toHaveLength(4)
    expect(messages.map((m) => m.id)).toEqual(['pos:0', 'pos:1', 'pos:2', 'pos:3'])
    expect(messages[0]).toMatchObject({ role: 'user', name: 'Denis', parts: [{ type: 'text', text: 'привет' }] })
    expect(messages.every((m) => m.swipes === undefined)).toBe(true)
    // без хедера — минимальный SessionInfo
    expect(session.id).toBe('')
    expect(session.messageCount).toBe(4)
  })

  it('round-trip nr-chat байт-точен (семантика не поехала)', () => {
    // модель сессии не трогает исходник; сам формат round-trip'ится
    expect(stringify(parse(LINEAR))).toBe(LINEAR)
  })

  it('совместимость: лог-преамбула до первого маркера игнорируется', () => {
    const withPreamble = `# заметка лога\n\n${LINEAR}`
    const session = parseSession(withPreamble)
    expect(session.nodes).toHaveLength(4)
    expect(session.nodes[0].role).toBe('user')
  })
})
