/**
 * nr-chat-специфика ревью (spec §1/§2/§5): parent:null три-стейт (ребёнок
 * удалённого корня не приклеивается к предыдущей записи), %%attach body переживает
 * edit (потеря данных п.4), traversal ассетов, delete сносит sidecar.
 */

import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveTree } from '../src/index.js'
import { createNrChatStore } from '../src/nr-chat/index.js'

const make = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mds-x-'))
  return { dir, store: createNrChatStore({ dir }) }
}

describe('parent:null три-стейт (§2)', () => {
  it('ребёнок удалённого корня становится явным корнем, не приклеивается к предыдущей записи', async () => {
    const { store } = make()
    const { id: sid } = await store.create({ id: 's' })
    const a = await store.appendNode(sid, { role: 'user', text: 'A' })
    const b = await store.appendNode(sid, { role: 'user', text: 'B', parent: null })
    const c = await store.appendNode(sid, { role: 'assistant', text: 'C', parent: b.id })

    await store.deleteNode(sid, b.id)
    const model = await store.load(sid)

    const cNode = model.nodes.find((n) => n.id === c.id)!
    // C НЕ приклеился к A (предыдущей записи в файле) — он явный корень.
    expect(cNode.parent).toBe(null)
    expect(cNode.parent).not.toBe(a.id)
    const roots = resolveTree(model.nodes).roots
    expect(roots.map((r) => r.id).sort()).toEqual([a.id, c.id].sort())
  })
})

describe('%%attach body переживает edit (§2, потеря данных п.4)', () => {
  it('извлечённый текст файла сохраняется при editNode текста-тела', async () => {
    const { store } = make()
    const { id: sid } = await store.create({ id: 's' })
    const node = await store.appendNode(sid, {
      role: 'user',
      parts: [
        { type: 'text', text: 'см файл' },
        { type: 'file', text: 'СОДЕРЖИМОЕ ФАЙЛА', meta: { name: 'a.pdf', mime: 'application/pdf', ref: 'file:x' } },
      ],
    })
    await store.editNode(sid, node.id, { text: 'изменённый текст' })
    const model = await store.load(sid)
    const parts = model.nodes.find((n) => n.id === node.id)!.parts
    expect(parts.find((p) => p.type === 'text')).toMatchObject({ text: 'изменённый текст' })
    const file = parts.find((p) => p.type === 'file')!
    expect((file as { text?: string }).text).toBe('СОДЕРЖИМОЕ ФАЙЛА')
  })
})

describe('assets traversal + delete sidecar (§1/§5)', () => {
  it('assets.put с traversal-именем отвергается', async () => {
    const { store } = make()
    const { id: sid } = await store.create({ id: 's' })
    await expect(store.assets!.put(sid, '../../evil', new Uint8Array([1]))).rejects.toBeInstanceOf(Error)
  })

  it('delete сносит {id}.assets рекурсивно', async () => {
    const { dir, store } = make()
    const { id: sid } = await store.create({ id: 's' })
    await store.assets!.put(sid, 'a.bin', new Uint8Array([1, 2, 3]))
    expect(existsSync(join(dir, `${sid}.assets`))).toBe(true)
    await store.delete!(sid)
    expect(existsSync(join(dir, `${sid}.assets`))).toBe(false)
  })
})
