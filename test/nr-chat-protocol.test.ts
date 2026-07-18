/**
 * mds-кодек §7 — проекция: фикстура ↔ Message[] против типов модели, pos:N для
 * нод без id, SessionInfo из %meta, флаги и meta. Перенос тестов nr-session
 * (NOT-274); типы модели — из дома анатомии (nr-chat-store), протокол их же ре-экспортит.
 */

import { describe, it, expect } from 'vitest'
import type { Message, SessionInfo } from '../src/index.js'
import { parseSession, toProtocol } from '../src/nr-chat/index.js'

const SESSION = `%meta {id: 'a3f9', title: 'разбор', botId: 'claude', createdAt: '2026-07-18T10:00:00Z'}
%user Denis
привет
%assistant {id: 'm2', model: 'opus', usage: {input: 10, output: 20}}
%%thinking {signature: 'sig'}
думаю
%%text
ответ
%system {hidden: true, frozen: true}
служебное
`

describe('проекция toProtocol', () => {
  it('SessionInfo из %meta (id, title, botId, createdAt)', () => {
    const { session } = toProtocol(parseSession(SESSION))
    const expected: SessionInfo = {
      id: 'a3f9',
      title: 'разбор',
      botId: 'claude',
      createdAt: '2026-07-18T10:00:00Z',
      messageCount: 3,
    }
    expect(session).toEqual(expected)
  })

  it('Message[] соответствует типам модели: id/pos:N, parts, flags, meta', () => {
    const { messages } = toProtocol(parseSession(SESSION))
    expect(messages).toHaveLength(3)

    // user — без id → pos:0 (hash навешивает ядро — сверяем по существу)
    expect(messages[0]).toMatchObject<Partial<Message>>({
      id: 'pos:0',
      role: 'user',
      name: 'Denis',
      parts: [{ type: 'text', text: 'привет' }],
    })
    expect(messages[0].hash).toEqual(expect.any(String))

    // assistant — явный id, thinking+text, meta.model/usage
    expect(messages[1].id).toBe('m2')
    expect(messages[1].parts).toEqual([
      { type: 'thinking', text: 'думаю', meta: { signature: 'sig' } },
      { type: 'text', text: 'ответ' },
    ])
    expect(messages[1].meta).toEqual({ model: 'opus', usage: { input: 10, output: 20 } })

    // system — флаги hidden/frozen из меты
    expect(messages[2].id).toBe('pos:2')
    expect(messages[2].flags).toEqual({ hidden: true, frozen: true })
  })

  it('pos:N считается по позиции среди обычных нод (не по строкам)', () => {
    const { messages } = toProtocol(parseSession(SESSION))
    // assistant с суб-нодами — index 1, но имеет явный id; system — index 2
    expect(messages.map((m) => m.id)).toEqual(['pos:0', 'm2', 'pos:2'])
  })
})
