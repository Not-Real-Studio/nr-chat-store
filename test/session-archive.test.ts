// Архив, теги и перенос сессии (DEV-354, протокол v1.55): флаги меты → `SessionInfo`,
// `move` — шапка (`workspace`, `project`), лента на месте.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '../src/nr-chat/index.js'
import { createMemoryStore } from '../src/memory/index.js'
import { archivedOf, normTags } from '../src/archive.js'
import type { SessionStore } from '../src/store.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function nrChat(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'nrcs-archive-'))
  dirs.push(dir)
  return createNrChatStore({ dir, indexFile: true })
}

describe.each([
  ['nr-chat', nrChat],
  ['memory', () => createMemoryStore()],
])('%s: архив, теги, перенос', (_name, make) => {
  it('meta → archived / archivedBy / tags', async () => {
    const store = make()
    const a = await store.create({ info: { title: 'a', workspace: 'dev' } })
    const b = await store.create({ info: { title: 'b' } })
    await store.meta!.patch(a.id, { archived: '2026-10-27T06:00:00.000Z', archivedBy: 'auto', tags: ['Infra', '#voice', 'infra', ' '] })
    await store.meta!.patch(b.id, { archived: false, archivedBy: 'auto' })
    const list = (await store.list()).sessions
    const ia = list.find((s) => s.id === a.id)!
    expect(ia.archived).toBe('2026-10-27T06:00:00.000Z')
    expect(ia.archivedBy).toBe('auto')
    expect(ia.tags).toEqual(['infra', 'voice'])
    const ib = list.find((s) => s.id === b.id)!
    expect(ib.archived).toBe(false)
    expect(ib.archivedBy).toBeUndefined()
    expect(ib.tags).toBeUndefined()
  })

  it('длинная шапка (мета подузлами): архив виден списку, в том числе из кэша (DEV-644)', async () => {
    const store = make()
    const title = `# DEV-359: ${'очень длинное имя задачи с телом спеки '.repeat(12)}`
    const a = await store.create({ info: { title, workspace: 'dev' } })
    await store.meta!.patch(a.id, { task: { issue: 'DEV-359', role: 'run' }, kind: 'run', contour: 'prod' })
    await store.meta!.patch(a.id, { archived: '2026-11-04T08:56:33.868Z', archivedBy: 'auto', tags: ['infra'] })
    for (let i = 0; i < 2; i++) {
      const info = (await store.list()).sessions.find((s) => s.id === a.id)!
      expect(info.archived).toBe('2026-11-04T08:56:33.868Z')
      expect(info.archivedBy).toBe('auto')
      expect(info.tags).toEqual(['infra'])
      expect(info.kind).toBe('run')
    }
  })

  it('move: пространство и проект шапки, лента цела', async () => {
    const store = make()
    const a = await store.create({ info: { title: 'a', workspace: 'dev', project: 'nrchat' } })
    await store.appendNode(a.id, { role: 'user', text: 'привет' })
    await store.move!(a.id, { workspace: 'slot' })
    let info = (await store.list()).sessions.find((s) => s.id === a.id)!
    expect(info.workspace).toBe('slot')
    expect(info.project).toBeUndefined()
    expect(info.title).toBe('a')
    await store.move!(a.id, { workspace: 'dev', project: 'nrlib' })
    info = (await store.load(a.id)).info
    expect(info.workspace).toBe('dev')
    expect(info.project).toBe('nrlib')
    expect((await store.load(a.id)).nodes.length).toBe(1)
  })
})

describe('normTags / archivedOf', () => {
  it('нормализует', () => {
    expect(normTags(['A', 'a', '#b', 3, '', '  c  '])).toEqual(['a', 'b', 'c'])
    expect(normTags('a')).toEqual([])
    expect(archivedOf(false)).toBe(false)
    expect(archivedOf('')).toBeUndefined()
    expect(archivedOf(true)).toBeUndefined()
  })
})
