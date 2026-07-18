/**
 * mds-кодек §7 — суб-ноды: сборка parts, %%text-продолжения, неизвестная
 * %%роль → custom, лестница экранирования \%%. Перенос тестов nr-session (NOT-274).
 */

import { describe, it, expect } from 'vitest'
import { parse, stringify } from '@notrealstudio/nr-chat'
import { parseSession, assembleParts } from '../src/mds/index.js'

const COMPOSITE = `%meta {id: 'a3f9', title: 'разбор отчёта'}
%user Denis
глянь этот файл
%%attach report.pdf {file: './a3f9-report.pdf', mime: 'application/pdf'}
Q3 revenue: 19,15M...
%assistant
%%thinking
сначала структура...
%%text
Вот что в отчёте: ...
%%tool_use {callId: 't1', name: 'look'}
{path: './data.csv'}
%%tool_result {callId: 't1'}
rows: 214
%%text
Итого: ...
`

describe('суб-ноды %%', () => {
  it('user: тело — первый text-part, %%attach → file-part с ref/mime', () => {
    const session = parseSession(COMPOSITE)
    const user = session.nodes[0]
    expect(user.role).toBe('user')
    expect(user.subNodes).toHaveLength(1)

    const parts = assembleParts(user)
    expect(parts[0]).toEqual({ type: 'text', text: 'глянь этот файл' })
    expect(parts[1]).toEqual({
      type: 'file',
      meta: { name: 'report.pdf', mime: 'application/pdf', ref: './a3f9-report.pdf' },
    })
  })

  it('assistant: пустое тело → без ведущего text-part, сборка по суб-нодам', () => {
    const session = parseSession(COMPOSITE)
    const asst = session.nodes[1]
    expect(asst.role).toBe('assistant')
    expect(asst.body).toBe('')

    const parts = assembleParts(asst)
    // thinking, text, tool_use, tool_result, text (без ведущего пустого текста)
    expect(parts.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_use', 'tool_result', 'text'])
    expect(parts[0]).toEqual({ type: 'thinking', text: 'сначала структура...' })
    expect(parts[1]).toEqual({ type: 'text', text: 'Вот что в отчёте: ...' })
    expect(parts[2]).toEqual({ type: 'tool_use', data: { path: './data.csv' }, meta: { callId: 't1', name: 'look' } })
    expect(parts[3]).toEqual({ type: 'tool_result', text: 'rows: 214', meta: { callId: 't1' } })
    expect(parts[4]).toEqual({ type: 'text', text: 'Итого: ...' })
  })

  it('%%text-продолжение: текст после суб-ноды — отдельный text-part', () => {
    const session = parseSession(COMPOSITE)
    const parts = assembleParts(session.nodes[1])
    const texts = parts.filter((p) => p.type === 'text')
    expect(texts).toHaveLength(2)
  })

  it('неизвестная %%роль → custom с hint = роль', () => {
    const src = `%assistant\nтекст\n%%weird {x: 1}\nданные\n`
    const parts = assembleParts(parseSession(src).nodes[0])
    expect(parts[1]).toMatchObject({ type: 'custom', text: 'данные', meta: { hint: 'weird', x: 1 } })
  })

  it('суб-ноды не несут id/parent, в дереве не участвуют', () => {
    const session = parseSession(COMPOSITE)
    // две обычные ноды несмотря на 6 суб-нод
    expect(session.nodes).toHaveLength(2)
    for (const node of session.nodes) {
      for (const sub of node.subNodes) {
        expect(sub.meta?.id).toBeUndefined()
        expect(sub.meta?.parent).toBeUndefined()
      }
    }
  })

  it('лестница экранирования: литеральная строка %%... в теле → \\%%..., round-trip', () => {
    // тело сообщения, буквально начинающееся с %% — nr-chat экранирует как \%%
    const literal = { role: 'user', body: '%%text\nэто не суб-нода' }
    const emitted = stringify([literal])
    expect(emitted).toContain('\\%%text')

    // round-trip: парсим обратно — тело восстанавливается байт-в-байт
    const back = parse(emitted)
    expect(back[0].body).toBe('%%text\nэто не суб-нода')

    // и как сессия: одна нода, без суб-ноды (экранированное %% не роль)
    const session = parseSession(emitted)
    expect(session.nodes).toHaveLength(1)
    expect(session.nodes[0].subNodes).toHaveLength(0)
  })
})
