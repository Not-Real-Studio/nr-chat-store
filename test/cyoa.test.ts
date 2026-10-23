/**
 * CYOA (cyoa-spec §8, DEV-454): заметки редактора по ходам, направление и тон
 * impersonate в сборке шаблоном.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Message, Persona } from '../src/model.js'
import { buildMdsTemplate, type BuildInput } from '../src/builder/index.js'
import { directionOf, editorNotesForTurn, textOf } from '../src/assembly/index.js'

const RP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'builder', 'rp.mds'), 'utf8')
const msg = (id: string, role: string, text: string, meta?: Message['meta']): Message => ({ id, role, parts: [{ type: 'text', text }], ...(meta ? { meta } : {}) })
const bot: Persona = { id: 'bot', kind: 'char', name: 'Scarlett', card: { description: 'Барменша.' } }
const me = { id: 'me', kind: 'user', name: 'Ann', card: {} } as Persona

function input(path: Message[], over: Partial<BuildInput> = {}): BuildInput {
  return {
    session: { id: 's1' },
    document: { path, meta: {}, personas: [bot, me], userId: 'me' },
    model: { id: 'm' },
    base: [],
    tools: [],
    agent: { id: 'rp', name: 'RP', template: RP, includes: {} },
    ...over,
  }
}

const editorNode = (nodes: Awaited<ReturnType<typeof buildMdsTemplate>>['nodes']) => nodes.find((n) => n.source === 'editor')

describe('заметки редактора: какие идут в ход', () => {
  // ход N — ответ b1 с заметками; N+1 — реплика u2; N+2 — b2, u3; N+3 — b3, u4
  const b1 = msg('b1', 'assistant', 'Ответ 1', { editorNotes: ['Не повторяй «улыбнулась».', 'Не пиши за Ann.'] })

  it('пустой notes — хвост без заметок', async () => {
    const out = await buildMdsTemplate(input([msg('b0', 'assistant', 'Привет', { editorNotes: [] }), msg('u1', 'user', 'Налей.')]))
    expect(editorNode(out.nodes)).toBeUndefined()
    expect(out.editor).toBeUndefined()
  })

  it('заметки хода N — в хвосте N+1 после реплики игрока, отметка — на неё', async () => {
    const out = await buildMdsTemplate(input([b1, msg('u2', 'user', 'Налей.')]))
    const at = out.nodes.findIndex((n) => n.source === 'editor')
    expect(at).toBeGreaterThan(0)
    expect(out.nodes[at - 1]!.id).toBe('u2')
    expect(textOf(out.nodes[at]!)).toContain('Не повторяй «улыбнулась».')
    expect(out.editor).toEqual({ anchor: 'u2', notes: [{ from: 'b1', i: 0, text: 'Не повторяй «улыбнулась».' }, { from: 'b1', i: 1, text: 'Не пиши за Ann.' }] })
    // по умолчанию — system посреди ленты; $lore_role: user — user-сообщением
    expect(out.nodes[at]!.injectSend).toBe('system')
    const asUser = await buildMdsTemplate(input([b1, msg('u2', 'user', 'Налей.')], { profileLore: { books: [], role: 'user' } }))
    expect(editorNode(asUser.nodes)!.injectRole).toBe('user')
    expect(editorNode(asUser.nodes)!.injectSend).toBeUndefined()
  })

  it('поданная в N+1 (editorApplied) в N+2 не подаётся; в N+3 заметок хода N нет', () => {
    const applied = msg('u2', 'user', 'Налей.', { editorApplied: [{ from: 'b1', i: 0 }, { from: 'b1', i: 1 }] })
    expect(editorNotesForTurn([b1, applied, msg('b2', 'assistant', 'Ответ 2'), msg('u3', 'user', 'Ещё.')]).notes).toEqual([])
    // не поданная (дописана позже) — уходит в ход после, пока b1 в окне двух ответов
    const late = msg('u2', 'user', 'Налей.')
    expect(editorNotesForTurn([b1, late, msg('b2', 'assistant', 'Ответ 2'), msg('u3', 'user', 'Ещё.')]).notes.map((n) => n.from)).toEqual(['b1', 'b1'])
    // N+3: окно — b2, b3; b1 устарела
    expect(editorNotesForTurn([b1, late, msg('b2', 'assistant', '2'), msg('u3', 'user', '3'), msg('b3', 'assistant', '3'), msg('u4', 'user', '4')]).notes).toEqual([])
  })

  it('перегенерация хода: своя отметка якоря не мешает подать заметки снова', () => {
    const u2 = msg('u2', 'user', 'Налей.', { editorApplied: [{ from: 'b1', i: 0 }] })
    expect(editorNotesForTurn([b1, u2]).notes).toHaveLength(2)
  })

  it('в impersonate заметок нет', async () => {
    const out = await buildMdsTemplate(input([msg('u0', 'user', 'Привет'), b1], { turn: { impersonate: true, input: '' } }))
    expect(editorNode(out.nodes)).toBeUndefined()
    const out2 = await buildMdsTemplate(input([b1, msg('u2', 'user', 'x')], { turn: { impersonate: true, input: '' } }))
    expect(editorNode(out2.nodes)).toBeUndefined()
  })
})

describe('impersonate: направление, тон одноразовый, заметка игрока', () => {
  const path = [msg('b1', 'assistant', 'Стражник у ворот.')]
  const impersonateText = (out: Awaited<ReturnType<typeof buildMdsTemplate>>) => textOf(out.nodes.find((n) => n.source === 'impersonate')!)

  it('direction последним, тон — только в этом ране, заметка — в обоих', async () => {
    const meta = { playerNote: 'Ann прячет нож.' }
    const first = await buildMdsTemplate(input(path, { document: { path, meta, personas: [bot, me], userId: 'me' }, turn: { impersonate: true, input: '', direction: { intent: 'отвлечь стражника разговором', tone: ['зло'], length: 'short' } } }))
    const t1 = impersonateText(first)
    expect(t1.split('\n').at(-1)).toBe('Direction — what Ann tries to do now: отвлечь стражника разговором')
    expect(t1).toContain('Tone for this reply: зло')
    expect(t1).toContain('Write an attempt, not an outcome')
    expect(t1).toContain("Ann's standing note: Ann прячет нож.")
    const second = await buildMdsTemplate(input(path, { document: { path, meta, personas: [bot, me], userId: 'me' }, turn: { impersonate: true, input: '' } }))
    const t2 = impersonateText(second)
    expect(t2).not.toContain('Tone for this reply')
    expect(t2).toContain("Ann's standing note: Ann прячет нож.")
  })

  it('directionOf: битая ось и пустое намерение', () => {
    expect(directionOf({ intent: ' ' })).toBeUndefined()
    expect(directionOf({ intent: '', tone: ['зло'] })).toEqual({ intent: '', tone: ['зло'] })
    expect(directionOf({ intent: 'x', axis: 'weird', tone: ['', 'зло'], length: 'huge' })).toEqual({ intent: 'x', tone: ['зло'] })
  })
})
