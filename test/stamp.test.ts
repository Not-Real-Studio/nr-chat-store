import { describe, expect, it } from 'vitest'
import { contextStamps, withStamp } from '../src/assembly/index.js'

const u = (createdAt: string, client?: Record<string, string>) => ({ role: 'user', meta: { createdAt, ...(client ? { client } : {}) } })
const a = { role: 'assistant', meta: { createdAt: '2026-10-22T12:31:00Z' } }

describe('contextStamps (DEV-426)', () => {
  it('время всегда, дата — при смене дня, устройство — при смене', () => {
    const tz = 'Europe/Warsaw'
    const s = contextStamps([
      u('2026-10-22T12:30:00Z', { device: 'air', place: 'Радом', tz }),
      a,
      u('2026-10-22T12:45:00Z', { device: 'air', place: 'Радом', tz }),
      u('2026-10-22T13:00:00Z', { device: 'phone', tz }),
      u('2026-10-22T22:10:00Z', { device: 'phone', tz }),
      { role: 'user', meta: {} },
    ])
    expect(s).toEqual([
      '[2026-10-22 Thu 14:30 · air (Радом)]',
      undefined,
      '[14:45]',
      '[15:00 · phone]',
      '[2026-10-23 Fri 00:10]',
      undefined,
    ])
  })

  it('одинаков на каждом ходе — от истории, не от «сейчас»', () => {
    const nodes = [u('2026-10-22T12:30:00Z', { device: 'air', tz: 'UTC' }), u('2026-10-22T12:40:00Z', { device: 'air', tz: 'UTC' })]
    expect(contextStamps(nodes)).toEqual(contextStamps(nodes.slice()))
    expect(contextStamps(nodes)[1]).toBe('[12:40]')
  })

  it('хвост — к последнему тексту, без текста — частью', () => {
    expect(withStamp([{ type: 'text', text: 'привет' }], '[12:00]')).toEqual([{ type: 'text', text: 'привет\n\n[12:00]' }])
    expect(withStamp([{ type: 'image' }], '[12:00]')).toEqual([{ type: 'image' }, { type: 'text', text: '[12:00]' }])
  })
})
