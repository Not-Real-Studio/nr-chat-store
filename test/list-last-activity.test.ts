/** Сортировка списка — по последнему сообщению: правка меты (открытие сессии ACP пишет systemHash) не поднимает сессию. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNrChatStore } from '../src/nr-chat/index.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** Бэкенды ставят `createdAt` узла сами — стор его не придумывает. */
const at = (): { meta: { createdAt: string } } => ({ meta: { createdAt: new Date().toISOString() } })

describe('list: updatedAt = последнее сообщение', () => {
  it('патч меты старой сессии не меняет порядок, новое сообщение — меняет', async () => {
    const store = createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'last-act-')) })
    const old = await store.create({ info: { title: 'старая' } })
    await store.appendNode(old.id, { role: 'user', text: 'a', ...at() })
    await wait(20)
    const fresh = await store.create({ info: { title: 'новая' } })
    await store.appendNode(fresh.id, { role: 'user', text: 'b', ...at() })
    expect((await store.list()).sessions.map((s) => s.title)).toEqual(['новая', 'старая'])

    await wait(20)
    await store.meta!.patch(old.id, { acp: { systemHash: 'x' } })
    expect((await store.list()).sessions.map((s) => s.title)).toEqual(['новая', 'старая'])

    await store.appendNode(old.id, { role: 'user', text: 'c', ...at() })
    expect((await store.list()).sessions.map((s) => s.title)).toEqual(['старая', 'новая'])
  })
})
