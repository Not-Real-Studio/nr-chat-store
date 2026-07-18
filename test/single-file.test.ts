/**
 * Single-file mode of the nr-chat driver (`createNrChatStore({ file })`) — one
 * session backed by an arbitrary file at a path (any extension), for single-doc
 * consumers (chat3/rpbot). fork is off; every other capability hits the one file.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toHistory, resolveTree, swipeInfo, type SessionStore } from '../src/index.js'
import { createNrChatStore } from '../src/nr-chat/index.js'

const texts = (msgs: { parts: { type: string }[] }[]): string[] =>
  msgs.map((m) => (m.parts.find((p) => p.type === 'text') as { text?: string } | undefined)?.text ?? '')

describe('nr-chat single-file mode', () => {
  let store: SessionStore
  afterEach(async () => {
    if (store?.close) await store.close()
  })

  function make(ext = '.md'): { store: SessionStore; sid: string } {
    const file = join(mkdtempSync(join(tmpdir(), 'nr-file-')), `chat${ext}`)
    store = createNrChatStore({ file })
    return { store, sid: 'chat' }
  }

  it('create → append → load: активный путь = порядок дозаписи (.md)', async () => {
    const { store, sid } = make('.md')
    await store.create({ id: sid })
    await store.appendNode(sid, { role: 'user', text: 'A' })
    await store.appendNode(sid, { role: 'assistant', text: 'B' })
    await store.appendNode(sid, { role: 'user', text: 'C' })
    expect(texts(toHistory(await store.load(sid)))).toEqual(['A', 'B', 'C'])
  })

  it('id игнорируется — любой sid попадает в тот же файл', async () => {
    const { store } = make('.mds')
    await store.create({ id: 'whatever' })
    await store.appendNode('any-id', { role: 'user', text: 'X' })
    expect(texts(toHistory(await store.load('другой-id-с-пробелом? ok')))).toEqual(['X'])
  })

  it('edit / delete / swipe работают на одном файле', async () => {
    const { store, sid } = make()
    await store.create({ id: sid })
    const a = await store.appendNode(sid, { role: 'user', text: 'A' })
    const b = await store.appendNode(sid, { role: 'assistant', text: 'B' })

    const edited = await store.editNode!(sid, a.id, { text: 'A*' })
    expect((edited.parts.find((p) => p.type === 'text') as { text: string }).text).toBe('A*')

    // swipe: sibling of b + setActiveLeaf
    const alt = await store.appendNode(sid, { role: 'assistant', text: 'B2', parent: a.id })
    await store.setActiveLeaf!(sid, alt.id)
    const model = await store.load(sid)
    expect(texts(toHistory(model)).at(-1)).toBe('B2')
    const tree = resolveTree(model.nodes)
    expect(swipeInfo(tree.byId.get(b.id)!, tree).count).toBe(2)

    await store.deleteNode!(sid, alt.id)
    expect(texts(toHistory(await store.load(sid))).includes('B2')).toBe(false)
  })

  it('capabilities: fork выключен, forkCopy отсутствует', async () => {
    const { store } = make()
    const caps = await store.capabilities()
    expect(caps.fork).toBe(false)
    expect(store.forkCopy).toBeUndefined()
    expect(caps.edits?.edit).toBe(true)
    expect(caps.swipes).toBe(true)
  })

  it('version меняется с содержимым', async () => {
    const { store, sid } = make()
    await store.create({ id: sid })
    await store.appendNode(sid, { role: 'user', text: 'A' })
    const v1 = await store.version!(sid)
    await store.appendNode(sid, { role: 'user', text: 'B' })
    expect(await store.version!(sid)).not.toBe(v1)
  })
})
