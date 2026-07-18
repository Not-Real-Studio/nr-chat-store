/**
 * nr-chat codec §7 — a linear file with no meta at all: chain, path, projection,
 * zero overhead, round-trip. Compatibility: existing linear files parse as-is.
 * Tree math is asserted through the projection (`toModel`) + the core.
 */

import { describe, it, expect } from 'vitest'
import { parse, stringify } from '@notrealstudio/nr-chat'
import { resolveTree, activePath } from '../src/index.js'
import { parseSession, toModel, toProtocol } from '../src/nr-chat/index.js'

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
    const { nodes } = toModel(session)
    const tree = resolveTree(nodes)

    expect(session.header).toBeUndefined()
    expect(nodes).toHaveLength(4)
    expect(tree.roots).toHaveLength(1)
    expect(tree.roots[0].id).toBe(nodes[0].id)

    // parent каждой ноды (развёрнутый) — предыдущая
    for (let i = 1; i < nodes.length; i++) {
      expect(nodes[i].parent).toBe(nodes[i - 1].id)
    }
  })

  it('активный путь = весь файл (лист = последняя нода)', () => {
    const model = toModel(parseSession(LINEAR))
    const path = activePath(model)
    expect(path.map((n) => n.id)).toEqual(model.nodes.map((n) => n.id))
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
