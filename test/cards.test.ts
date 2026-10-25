import { describe, expect, it } from 'vitest'
import type { Message, SessionInfo } from '../src/model.js'
import { buildCard, buildDigest, cardEntries, cardMessages, fixFact, parseCard, parseModelJson, renderCard, type CardComplete } from '../src/cards/index.js'

const msg = (id: string, role: string, text: string, at = '2026-10-22T10:00:00Z', extra: Partial<Message> = {}): Message => ({ id, role, parts: [{ type: 'text', text }], meta: { createdAt: at } as never, ...extra })

const chat: Message[] = [
  msg('u1', 'user', 'Сделай карточки чатов'),
  msg('a1', 'assistant', 'Предлагаю писать card.md рядом с сессией'),
  msg('a2', 'assistant', 'и сводку за N дней'),
  { id: 't1', role: 'tool', parts: [{ type: 'text', text: 'вывод тула' }] },
  msg('u2', 'user', 'да', '2026-10-22T11:00:00Z'),
  msg('u3', 'user', 'выключенная', '2026-10-22T11:01:00Z', { flags: { disabled: true } }),
]

describe('cardMessages', () => {
  it('только user/assistant с текстом, ход ассистента склеен, якорь — первая нода', () => {
    const m = cardMessages(chat)
    expect(m.map((x) => [x.i, x.id, x.role])).toEqual([
      [1, 'u1', 'user'],
      [2, 'a1', 'assistant'],
      [3, 'u2', 'user'],
    ])
    expect(m[1]!.text).toContain('сводку за N дней')
  })
})

describe('fixFact — правила статусов', () => {
  const m = cardMessages(chat)
  it('решение ассистента + короткое «да» Дениса = решение Дениса с якорем на согласии', () => {
    const f = fixFact({ text: 'card.md рядом', status: 'decision', by: 'assistant', anchor: 2 }, m)
    expect(f).toMatchObject({ status: 'decision', by: 'denis', anchor: 3, of: 2 })
  })
  it('из вставки решения не бывает; автор — по роли якоря', () => {
    expect(fixFact({ text: 'x', status: 'decision', by: 'denis', src: 'paste_agent', anchor: 1 }, m)).toMatchObject({ by: 'agent', status: 'report' })
    expect(fixFact({ text: 'x', status: 'report', by: 'denis', anchor: 2 }, m)).toMatchObject({ by: 'assistant' })
    expect(fixFact({ text: 'x', status: 'verified', by: 'assistant', anchor: 2 }, m)).toMatchObject({ status: 'report' })
    expect(fixFact({ text: 'x', anchor: 99 }, m)).toBeNull()
  })
})

describe('parseModelJson', () => {
  it('ограда, висячая запятая, оборванный хвост', () => {
    expect(parseModelJson('```json\n{"a":[1,2,],}\n```')).toEqual({ a: [1, 2] })
    expect(parseModelJson('{"a":[{"t":"x"},{"t":"y"')).toEqual({ a: [{ t: 'x' }, { t: 'y' }] })
  })
})

describe('buildCard + card.md', () => {
  it('короткий чат — без сегментации; якоря → id нод; карточка читается обратно', async () => {
    const calls: string[] = []
    const complete: CardComplete = async ({ system }) => {
      calls.push(system.slice(0, 20))
      if (system.includes('карточку чата')) return { text: JSON.stringify({ title: 'Карточки чатов', about: 'договорились о card.md', decided: [{ text: 'card.md рядом с сессией', anchors: [3] }], agent: [], done: [], open: [{ text: 'сводка', anchors: [2] }], waiting: [{ text: 'слово на релиз', anchors: [99, 3] }] }), cost: 0.01 }
      return { text: JSON.stringify({ facts: [{ text: 'card.md рядом', status: 'decision', by: 'assistant', anchor: 2 }], open: [], wait: [] }), cost: 0.002 }
    }
    const r = await buildCard(chat, { complete, title: 'без названия' })
    expect(calls.length).toBe(2) // извлечение + запись, сегментации нет
    expect(r!.record.decided).toEqual([{ text: 'card.md рядом с сессией', anchors: ['u2'] }])
    expect(r!.record.waiting[0]!.anchors).toEqual(['u2'])
    expect(r!.usage.cost).toBeCloseTo(0.012)
    const text = renderCard(r!.record, { session: 's1', kind: 'talk', workspace: 'dev', source: '2026-10-22T11:00:00Z', usage: r!.usage, generated: '2026-10-22T12:00:00Z' })
    expect(text).toContain('[#u2](#/s/s1?m=u2)')
    const doc = parseCard(text)!
    expect(doc.head).toMatchObject({ session: 's1', title: 'Карточки чатов', workspace: 'dev', source: '2026-10-22T11:00:00Z', cost: 0.012 })
    expect(doc.sections['Ждёт Дениса']).toHaveLength(1)
    expect(doc.sections['Решил агент']).toEqual([])
  })
  it('пустой чат — null, модель не зовётся', async () => {
    expect(await buildCard([], { complete: async () => ({ text: '' }) })).toBeNull()
  })
})

describe('buildDigest', () => {
  it('только talk за период, по пространствам, общий список «ждёт Дениса»', () => {
    const now = new Date('2026-10-22T20:00:00Z')
    const card = (session: string, title: string, wait: string) =>
      parseCard(`---\nsession: ${session}\ntitle: "${title}"\nabout: "о чём"\nlast: 2026-10-22T10:00:00Z\n---\n# x\n\n## Висит\n—\n\n## Ждёт Дениса\n- ${wait}\n`)
    const s = (id: string, extra: Partial<SessionInfo>): SessionInfo => ({ id, updatedAt: '2026-10-22T10:00:00Z', messageCount: 3, kind: 'talk', ...extra })
    const doc = buildDigest(
      [
        { info: s('a', { workspace: 'slot' }), card: card('a', 'Клеопатра', '~/.npmrc для публикации') },
        { info: s('b', { workspace: 'pm' }), card: card('b', 'Мит 2026-10-22', 'ветка dev-415') },
        { info: s('c', { kind: 'run' }) },
        { info: s('d', { updatedAt: '2026-10-10T00:00:00Z' }) },
        { info: s('e', { noCloud: true }) },
      ],
      { days: 2, now },
    )
    expect(doc).toContain('## slot')
    expect(doc).toContain('[Мит 2026-10-22](#/s/b)')
    expect(doc).toMatch(/Ждёт Дениса — всё[\s\S]*~\/\.npmrc[\s\S]*dev-415/)
    expect(doc).not.toContain('#/s/c')
    expect(doc).not.toContain('#/s/d')
    expect(doc).not.toContain('#/s/e')
  })
})

describe('cardEntries (DEV-492)', () => {
  const text = (wait: string): string =>
    `---\nsession: s1\ntitle: "t"\nabout: "a"\n---\n# t\n\n## Висит\n- Хвост про релиз ([#abc123](#/s/s1?m=abc123def))\n\n## Ждёт Дениса\n${wait}\n`
  it('текст без якорей, ноды, ключ устойчив к пробелам и точке', () => {
    const a = cardEntries(parseCard(text('- Решить про лимиты ([#n1](#/s/s1?m=n1), [#n2](#/s/s1?m=n2))'))!)
    expect(a).toHaveLength(2)
    const w = a.find((e) => e.section === 'Ждёт Дениса')!
    expect(w.text).toBe('Решить про лимиты')
    expect(w.anchors).toEqual(['n1', 'n2'])
    const b = cardEntries(parseCard(text('- Решить  про лимиты. ([#x](#/s/s1?m=x))'))!, ['Ждёт Дениса'])
    expect(b).toHaveLength(1)
    expect(b[0]!.key).toBe(w.key)
    expect(a.find((e) => e.section === 'Висит')!.key).not.toBe(w.key)
  })
  it('пустой раздел — без пунктов', () => {
    expect(cardEntries(parseCard(text('—'))!, ['Ждёт Дениса'])).toEqual([])
  })
})
