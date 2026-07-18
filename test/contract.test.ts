/**
 * Контракт-сюита — одна на всех (spec §8). Параметризованный прогон над каждым
 * драйвером: load/append/branch/edit/delete/hide/setActiveLeaf/forkCopy по
 * заявленным capabilities; незаявленное — отсутствует.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { toHistory, resolveTree, swipeInfo, type Message, type SessionStore, type StoreNode } from '../src/index.js'
import { createNrChatStore } from '../src/nr-chat/index.js'
import { createPiStore } from '../src/pi/index.js'
import { createClaudeStore } from '../src/claude/index.js'
import { createMemoryStore } from '../src/memory/index.js'

interface Driver {
  name: string
  make(): SessionStore
}

const drivers: Driver[] = [
  { name: 'nr-chat', make: () => createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'nr-chat-')) }) },
  { name: 'pi', make: () => createPiStore({ dir: mkdtempSync(join(tmpdir(), 'pi-')), cwd: '/w', pinVersion: 3 }) },
  { name: 'claude', make: () => createClaudeStore({ dir: mkdtempSync(join(tmpdir(), 'cl-')), cwd: '/w' }) },
  { name: 'memory', make: () => createMemoryStore() },
]

const texts = (nodes: StoreNode[]): string[] =>
  nodes.map((n) => n.parts.find((p) => p.type === 'text')?.text ?? '')

const histTexts = (msgs: Message[]): string[] =>
  msgs.map((m) => m.parts.find((p) => p.type === 'text')?.text ?? '')

for (const driver of drivers) {
  describe(`contract: ${driver.name}`, () => {
    let store: SessionStore
    afterEach(async () => {
      if (store.close) await store.close()
    })

    async function seed(): Promise<{ sid: string; a: StoreNode; b: StoreNode; c: StoreNode }> {
      store = driver.make()
      const info = await store.create({})
      const sid = info.id
      const a = await store.appendNode(sid, { role: 'user', text: 'A' })
      const b = await store.appendNode(sid, { role: 'assistant', text: 'B' })
      const c = await store.appendNode(sid, { role: 'user', text: 'C' })
      return { sid, a, b, c }
    }

    it('create → append → load: активный путь = порядок дозаписи', async () => {
      const { sid } = await seed()
      const model = await store.load(sid)
      expect(histTexts(toHistory(model))).toEqual(['A', 'B', 'C'])
    })

    it('appendNode возвращает узел со стабильным id и родителем', async () => {
      const { sid, a, b } = await seed()
      expect(a.id).toBeTruthy()
      expect(b.parent).toBe(a.id)
      const model = await store.load(sid)
      expect(model.nodes.some((n) => n.id === a.id)).toBe(true)
    })

    it('id-first: явный NodeInput.id соблюдается verbatim (§2)', async () => {
      store = driver.make()
      const { id: sid } = await store.create({})
      const node = await store.appendNode(sid, { id: 'my-node-id', role: 'user', text: 'hi' })
      expect(node.id).toBe('my-node-id')
      const model = await store.load(sid)
      expect(model.nodes.some((n) => n.id === 'my-node-id')).toBe(true)
    })

    it('дубль node id → отказ (§2)', async () => {
      store = driver.make()
      const { id: sid } = await store.create({})
      await store.appendNode(sid, { id: 'dup', role: 'user', text: 'a' })
      await expect(store.appendNode(sid, { id: 'dup', role: 'assistant', text: 'b' })).rejects.toThrow()
    })

    it('name round-trip (§2)', async () => {
      store = driver.make()
      const { id: sid } = await store.create({})
      const node = await store.appendNode(sid, { role: 'user', name: 'Denis', text: 'hi' })
      expect(node.name).toBe('Denis')
      const model = await store.load(sid)
      expect(model.nodes.find((n) => n.id === node.id)?.name).toBe('Denis')
    })

    it('parent:null → новый корень (§2)', async () => {
      store = driver.make()
      const { id: sid } = await store.create({})
      const a = await store.appendNode(sid, { role: 'user', text: 'A' })
      const b = await store.appendNode(sid, { role: 'user', text: 'B2', parent: null })
      expect(b.parent).toBe(null)
      const model = await store.load(sid)
      // survives parse/write: два корня в дереве.
      expect(resolveTree(model.nodes).roots).toHaveLength(2)
      expect(model.nodes.find((n) => n.id === a.id)?.parent).toBe(null)
    })

    describe('traversal-guard (§1)', () => {
      it('create({id: "../../evil"}) отвергается', async () => {
        await expect(driver.make().create({ id: '../../evil' })).rejects.toMatchObject({ code: 'invalid_id' })
      })
      it('appendNode с id-с-traversal отвергается', async () => {
        store = driver.make()
        const { id: sid } = await store.create({})
        await expect(store.appendNode(sid, { id: '../evil', role: 'user', text: 'x' })).rejects.toMatchObject({
          code: 'invalid_id',
        })
      })
    })

    it('list({limit:1}) отдаёт одну сессию + курсор (§5)', async () => {
      store = driver.make()
      await store.create({})
      await store.create({})
      const first = await store.list({ limit: 1 })
      expect(first.sessions).toHaveLength(1)
      expect(first.cursor).toBeTruthy()
      const second = await store.list({ limit: 1, cursor: first.cursor })
      expect(second.sessions).toHaveLength(1)
      expect(second.sessions[0].id).not.toBe(first.sessions[0].id)
    })

    it('branch: append с явным parent = sibling, swipeInfo.count > 1', async () => {
      const { sid, a, b } = await seed()
      const alt = await store.appendNode(sid, { role: 'assistant', text: 'B2', parent: a.id })
      expect(alt.parent).toBe(a.id)
      const model = await store.load(sid)
      const tree = resolveTree(model.nodes)
      const bNode = tree.byId.get(b.id)!
      expect(swipeInfo(bNode, tree).count).toBe(2)
    })

    it('версия сессии меняется с содержимым', async () => {
      const { sid } = await seed()
      if (!store.version) return
      const v1 = await store.version(sid)
      await store.appendNode(sid, { role: 'user', text: 'D' })
      const v2 = await store.version(sid)
      expect(v1).not.toBe(v2)
    })

    describe('capabilities ↔ методы', () => {
      it('edits.edit ⟺ editNode', async () => {
        const caps = await driver.make().capabilities()
        if (caps.edits?.edit) {
          const { sid, a } = await seed()
          const edited = await store.editNode!(sid, a.id, { text: 'A*' })
          expect(edited.parts.find((p) => p.type === 'text')?.text).toBe('A*')
        } else {
          expect(driver.make().editNode).toBeUndefined()
        }
      })

      it('editNode.ifHash: mismatch → conflict', async () => {
        const caps = await driver.make().capabilities()
        if (!caps.edits?.edit) return
        const { sid, a } = await seed()
        await expect(store.editNode!(sid, a.id, { text: 'X', ifHash: 'deadbeef' })).rejects.toMatchObject({
          code: 'conflict',
        })
      })

      it('editNode.text: остальные parts сохраняются', async () => {
        const caps = await driver.make().capabilities()
        if (!caps.edits?.edit) return
        store = driver.make()
        const { id: sid } = await store.create({})
        const n = await store.appendNode(sid, {
          role: 'assistant',
          parts: [
            { type: 'thinking', text: 'мысль' },
            { type: 'text', text: 'ответ' },
          ],
        })
        const edited = await store.editNode!(sid, n.id, { text: 'новый' })
        expect(edited.parts.map((p) => p.type)).toEqual(['thinking', 'text'])
        expect(edited.parts.find((p) => p.type === 'text')?.text).toBe('новый')
      })

      it('edits.delete ⟺ deleteNode (дети перецепляются на родителя)', async () => {
        const caps = await driver.make().capabilities()
        if (caps.edits?.delete) {
          const { sid, a, b, c } = await seed()
          await store.deleteNode!(sid, b.id)
          const model = await store.load(sid)
          expect(model.nodes.some((n) => n.id === b.id)).toBe(false)
          const cNode = model.nodes.find((n) => n.id === c.id)!
          expect(cNode.parent).toBe(a.id)
        } else {
          expect(driver.make().deleteNode).toBeUndefined()
        }
      })

      it('edits.hide ⟺ hideNode', async () => {
        const caps = await driver.make().capabilities()
        if (caps.edits?.hide) {
          const { sid, b } = await seed()
          await store.hideNode!(sid, b.id, true)
          let model = await store.load(sid)
          expect(model.nodes.find((n) => n.id === b.id)?.flags?.hidden).toBe(true)
          await store.hideNode!(sid, b.id, false)
          model = await store.load(sid)
          expect(model.nodes.find((n) => n.id === b.id)?.flags?.hidden).toBeUndefined()
        } else {
          expect(driver.make().hideNode).toBeUndefined()
        }
      })

      it('swipes ⟺ setActiveLeaf', async () => {
        const caps = await driver.make().capabilities()
        if (caps.swipes) {
          const { sid, a, b } = await seed()
          const alt = await store.appendNode(sid, { role: 'assistant', text: 'B2', parent: a.id })
          await store.setActiveLeaf!(sid, alt.id)
          const model = await store.load(sid)
          const active = toHistory(model)
          expect(active[active.length - 1].parts.find((p) => p.type === 'text')?.text).toBe('B2')
          expect(active.some((m) => m.id === b.id)).toBe(false)
        } else {
          expect(driver.make().setActiveLeaf).toBeUndefined()
        }
      })

      it('fork ⟺ forkCopy (новая сессия из активного пути)', async () => {
        const caps = await driver.make().capabilities()
        if (caps.fork) {
          const { sid, b } = await seed()
          const fork = await store.forkCopy!(sid, b.id)
          expect(fork.id).not.toBe(sid)
          expect(fork.parentSessionId).toBe(sid)
          const model = await store.load(fork.id)
          expect(histTexts(toHistory(model))).toEqual(['A', 'B'])
        } else {
          expect(driver.make().forkCopy).toBeUndefined()
        }
      })

      it('forkCopy с неизвестным atNodeId → not_found (§5)', async () => {
        const caps = await driver.make().capabilities()
        if (!caps.fork) return
        const { sid } = await seed()
        await expect(store.forkCopy!(sid, 'no-such-node')).rejects.toMatchObject({ code: 'not_found' })
      })

      it('sessionMeta ⟺ meta', async () => {
        const caps = await driver.make().capabilities()
        if (caps.sessionMeta) {
          const { sid } = await seed()
          await store.meta!.patch(sid, { note: 'привет' })
          const got = await store.meta!.get(sid)
          expect(got.note).toBe('привет')
        } else {
          expect(driver.make().meta).toBeUndefined()
        }
      })

      it('assets ⟺ assets', async () => {
        const caps = await driver.make().capabilities()
        if (caps.assets) {
          const { sid } = await seed()
          const { ref } = await store.assets!.put(sid, 'a.bin', new Uint8Array([1, 2, 3]))
          expect(ref).toContain('a.bin')
        } else {
          expect(driver.make().assets).toBeUndefined()
        }
      })
    })
  })
}
