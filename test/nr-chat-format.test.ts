/**
 * mds-кодек §4/§6 — format-ключ и decoders; %%-суб-ноды хедера → sessionMeta.
 * Перенос тестов nr-session (NOT-274): кодек живёт в nr-chat-store/mds.
 */

import { describe, expect, it } from 'vitest'
import { parseSession, toProtocol, sessionMetaOf } from '../src/nr-chat/index.js'

const toonish = (body: string) => ({ decoded: body.trim().split('\n').length })

describe('format-ключ и decoders (§4/§6)', () => {
  it('tool_result с format: инъектированный декодер даёт data, text сохраняется', () => {
    const text = [
      "%meta {id: 's1'}",
      '%assistant',
      'ok',
      "%%tool_result {callId: 't1', format: 'toon'}",
      'users[2]{id,name}:',
      '  1,Alice',
      '  2,Bob',
      '',
    ].join('\n')
    const { messages } = toProtocol(parseSession(text), { decoders: { toon: toonish } })
    const part = messages[0].parts.find((p) => p.type === 'tool_result')!
    expect(part).toMatchObject({ type: 'tool_result', data: { decoded: 3 } })
    expect((part as { text?: string }).text).toContain('Alice')
  })

  it('неизвестный/непереданный format → data = сырая строка, не ошибка', () => {
    const text = ["%meta {id: 's1'}", '%assistant', "%%tool_result {callId: 't1', format: 'proto9'}", 'raw stuff', ''].join('\n')
    const { messages } = toProtocol(parseSession(text))
    const part = messages[0].parts.find((p) => p.type === 'tool_result')!
    expect((part as { data?: unknown }).data).toBe('raw stuff')
  })

  it('tool_use без format — дефолт роли JSON5', () => {
    const text = ["%meta {id: 's1'}", '%assistant', "%%tool_use {callId: 't1', name: 'look'}", "{path: './a.csv'}", ''].join('\n')
    const { messages } = toProtocol(parseSession(text))
    const part = messages[0].parts.find((p) => p.type === 'tool_use')!
    expect((part as { data?: unknown }).data).toEqual({ path: './a.csv' })
  })
})

describe('%%-суб-ноды хедера → sessionMeta (§2)', () => {
  const text = [
    "%meta {id: 's1', title: 'кампания'}",
    "%%state {format: 'json5'}",
    '{hp: 10, gold: 3}',
    '%%notes',
    'свободный текст заметок',
    '%user',
    'привет',
    '',
  ].join('\n')

  it('суб-ноды прикрепляются к хедеру, не теряются и не текут в messages', () => {
    const session = parseSession(text)
    expect(session.header?.subNodes.map((s) => s.kind)).toEqual(['state', 'notes'])
    const { messages } = toProtocol(session)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
  })

  it('sessionMetaOf: имя суб-роли = ключ, body по format (без format — текст)', () => {
    const meta = sessionMetaOf(parseSession(text))
    expect(meta.state).toEqual({ hp: 10, gold: 3 })
    expect(meta.notes).toBe('свободный текст заметок')
  })

  it('span хедера накрывает его суб-ноды', () => {
    const session = parseSession(text)
    const headerSlice = text.slice(session.header!.span.start, session.header!.span.end)
    expect(headerSlice).toContain('заметок')
  })
})
