import { describe, expect, it } from 'vitest'
import { isAutoTitle, sessionKindOf, titleSourceOf } from '../src/kind.js'
import { parseSession } from '../src/nr-chat/session.js'
import { headerToSessionInfo } from '../src/nr-chat/protocol.js'

describe('sessionKindOf (DEV-428)', () => {
  it('явный kind главнее правил', () => {
    expect(sessionKindOf({ kind: 'talk', title: 'DEV-1 · исполнитель' })).toBe('talk')
    expect(sessionKindOf({ kind: 'мусор', title: 'DEV-1 · исполнитель' })).toBe('run')
  })
  it('задача: мета, потом заголовок старых сессий', () => {
    expect(sessionKindOf({ task: { issue: 'DEV-1', role: 'executor' } })).toBe('run')
    expect(sessionKindOf({ task: { issue: 'DEV-1', role: 'acceptor' } })).toBe('review')
    expect(sessionKindOf({ title: 'SLOT-83 · приёмщик' })).toBe('review')
    expect(sessionKindOf({ title: '# DEV-406: Ночной e2e-live' })).toBe('run')
  })
  it('пробы: qa-, lab, пустое пространство на dev; число реплик не критерий', () => {
    expect(sessionKindOf({ title: 'qa-dev410 dev acp', workspace: 'dev' })).toBe('probe')
    expect(sessionKindOf({ title: 'что угодно', contour: 'lab', workspace: 'dev' })).toBe('probe')
    expect(sessionKindOf({ title: 'Скажи одно слово', contour: 'dev' })).toBe('probe')
    expect(sessionKindOf({ title: 'Короткий', contour: 'dev', workspace: 'pm' })).toBe('talk')
  })
  it('автопрогоны и RP', () => {
    expect(sessionKindOf({ profile: 'slot-step', title: 'djf: rules' })).toBe('auto')
    expect(sessionKindOf({ title: 'nr-code: lucky-penny' })).toBe('auto')
    expect(sessionKindOf({ workspace: 'rp', title: 'Rachel' })).toBe('rp')
    expect(sessionKindOf({ workspace: 'bot', title: 'Greta', persona: true })).toBe('rp')
    expect(sessionKindOf({ workspace: 'pm', title: 'Мит 2026-10-22' })).toBe('talk')
  })
})

describe('titleSourceOf (DEV-428 §3)', () => {
  it('явная пометка, ручное ACP, автоимя, агент', () => {
    expect(titleSourceOf({ explicit: 'create', title: 'Мит 2026-10-20', acp: true })).toBe('create')
    expect(titleSourceOf({ title: 'Мит', userTitle: true, acp: true })).toBe('user')
    const auto = 'а'.repeat(40) + '…'
    expect(isAutoTitle(auto)).toBe(true)
    expect(isAutoTitle('а'.repeat(39) + '…')).toBe(false)
    expect(titleSourceOf({ title: auto, acp: true })).toBe('auto')
    expect(titleSourceOf({ title: 'Раннер записи сессий', acp: true })).toBe('agent')
    expect(titleSourceOf({ title: 'Kate' })).toBe('user')
    expect(titleSourceOf({})).toBeUndefined()
  })
})

describe('headerToSessionInfo: kind, titleSource, noCloud', () => {
  it('из шапки ACP-сессии с задачей подузлом', () => {
    const text = [
      "%meta {id: 's1', title: 'DEV-9 · исполнитель', workspace: 'dev', sessionMeta: {contour: 'prod', titleSource: 'create', noCloud: true}}",
      "%%task {format: 'json5'}",
      "{issue: 'DEV-9', role: 'executor'}",
      "%%acp {format: 'json5'}",
      "{\n  sessionId: 'x',\n  profile: 'nrchat',\n  userTitle: true,\n}",
      '',
    ].join('\n')
    const info = headerToSessionInfo(parseSession(text).header, 0)
    expect(info.kind).toBe('run')
    expect(info.task).toEqual({ issue: 'DEV-9', role: 'executor' })
    expect(info.titleSource).toBe('create')
    expect(info.noCloud).toBe(true)
  })
  it('без явной пометки: userTitle связи — user; персона-бот — rp', () => {
    const acp = parseSession("%meta {id: 's2', title: 'Мит 2026-10-20', workspace: 'pm'}\n%%acp {format: 'json5'}\n{\n  userTitle: true,\n}\n").header
    expect(headerToSessionInfo(acp, 0)).toMatchObject({ kind: 'talk', titleSource: 'user' })
    const rp = parseSession("%meta {id: 's3', title: 'Kate', workspace: 'bot'}\n%%character kate {kind: 'char', name: 'Kate'}\nтело\n").header
    expect(headerToSessionInfo(rp, 0).kind).toBe('rp')
  })
})
