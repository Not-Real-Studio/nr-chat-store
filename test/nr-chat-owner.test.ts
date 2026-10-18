// Автор и «поделиться» сессии (users-spec §4, протокол v1.30): хаб пишет их в
// мету (`meta.patch`), стор отдаёт полями `SessionInfo.owner` / `shared`.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '../src/nr-chat/index.js'
import { shareOf } from '../src/nr-chat/protocol.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('nr-chat: owner / shared', () => {
  it('meta.patch {owner, shared} → list и load отдают поля', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nrcs-owner-'))
    dirs.push(dir)
    const store = createNrChatStore({ dir })
    const a = await store.create({})
    const b = await store.create({})
    await store.meta!.patch(a.id, { owner: 'olena', shared: { users: ['kid1'], write: true } })
    const list = (await store.list()).sessions
    const ia = list.find((s) => s.id === a.id)!
    expect(ia.owner).toBe('olena')
    expect(ia.shared).toEqual({ users: ['kid1'], write: true })
    expect(list.find((s) => s.id === b.id)!.owner).toBeUndefined()
    expect((await store.load(a.id)).info.owner).toBe('olena')
  })

  it('shareOf: пустое и чужие формы — нет шаринга', () => {
    expect(shareOf(undefined)).toBeUndefined()
    expect(shareOf({ write: true })).toBeUndefined()
    expect(shareOf({ users: [] })).toBeUndefined()
    expect(shareOf(['a'])).toBeUndefined()
    expect(shareOf({ project: true })).toEqual({ project: true })
    expect(shareOf({ users: ['a', 1, ''], project: 'yes' })).toEqual({ users: ['a'] })
  })
})

describe('nr-chat: pinned (DEV-365)', () => {
  it('meta.patch {pinned: true} → list и load отдают флаг; null — снимает', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nrcs-pin-'))
    dirs.push(dir)
    const store = createNrChatStore({ dir })
    const a = await store.create({})
    const b = await store.create({})
    await store.meta!.patch(a.id, { pinned: true })
    const list = (await store.list()).sessions
    expect(list.find((s) => s.id === a.id)!.pinned).toBe(true)
    expect(list.find((s) => s.id === b.id)!.pinned).toBeUndefined()
    expect((await store.load(a.id)).info.pinned).toBe(true)
    await store.meta!.patch(a.id, { pinned: null })
    expect((await store.list()).sessions.find((s) => s.id === a.id)!.pinned).toBeUndefined()
  })
})
