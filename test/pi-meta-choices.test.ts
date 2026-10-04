/**
 * pi-драйвер в режиме `piServiceEntries: 'hide'`: мета сессии (формат
 * pi-ext-session-meta / backend-pi), выбор модели/профиля (`choices`) и кэш list().
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPiStore } from '../src/pi/index.js'

type Line = Record<string, unknown> & { type: string; id: string; parentId: string | null }

function fresh(): { dir: string; store: ReturnType<typeof createPiStore> } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-meta-'))
  return { dir, store: createPiStore({ dir, piServiceEntries: 'hide' }) }
}

function lines(dir: string): Line[] {
  const file = readdirSync(dir).find((n) => n.endsWith('.jsonl'))!
  return readFileSync(join(dir, file), 'utf-8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => JSON.parse(l) as Line)
}

/** Активная ветка файла — та же семантика, что `readSessionMeta` backend-pi (activePath от последней записи). */
function branch(entries: Line[]): Line[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const out: Line[] = []
  for (let cur = entries.at(-1); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) out.unshift(cur)
  return out
}

/** Копия алгоритма `readSessionMeta` (pi-ext-session-meta/src/meta.ts) — проверка совместимости формата. */
function extReadSessionMeta(path: Line[]): Record<string, unknown> {
  let doc: Record<string, unknown> = {}
  for (const entry of path) {
    if (entry.type !== 'custom' || entry.customType !== 'nr-session-meta') continue
    const data = entry.data
    if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
    doc = data as Record<string, unknown>
  }
  return doc
}

describe('pi hide: meta', () => {
  it('get/set/patch; capability sessionMeta; запись — custom nr-session-meta с полным документом', async () => {
    const { dir, store } = fresh()
    expect((await store.capabilities()).sessionMeta).toBe(true)
    const s = await store.create()
    expect(await store.meta!.get(s.id)).toEqual({})

    await store.appendNode(s.id, { role: 'user', text: 'q' })
    await store.meta!.set!(s.id, { prompt: { pre: 'ты кот' }, notes: 'n' })
    await store.meta!.patch(s.id, { notes: 'n2', extra: 1 })
    expect(await store.meta!.get(s.id)).toEqual({ prompt: { pre: 'ты кот' }, notes: 'n2', extra: 1 })

    const file = lines(dir)
    const metas = file.filter((e) => e.type === 'custom' && e.customType === 'nr-session-meta')
    expect(metas).toHaveLength(2)
    expect(metas[1]).toMatchObject({ parentId: metas[0]!.id, data: { prompt: { pre: 'ты кот' }, notes: 'n2', extra: 1 } })
    expect(metas[0]!.parentId).toBe(file[0]!.id)
    expect(typeof metas[0]!.timestamp).toBe('string')
    // То, что записал драйвер, читает расширение pi (и backend-pi) — тем же документом.
    expect(extReadSessionMeta(branch(file))).toEqual(await store.meta!.get(s.id))
  })

  it('set заменяет документ целиком (ключ можно удалить); data не объект — пропуск', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    await store.meta!.set!(s.id, { a: 1, b: 2 })
    await store.meta!.set!(s.id, { a: 1 })
    expect(await store.meta!.get(s.id)).toEqual({ a: 1 })
    // Битая запись поверх — не отнимает документ.
    const file = readdirSync(dir).find((n) => n.endsWith('.jsonl'))!
    const last = lines(dir).at(-1)!
    const bad = { type: 'custom', id: 'bad00001', parentId: last.id, timestamp: 't', customType: 'nr-session-meta', data: [1] }
    writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf-8') + JSON.stringify(bad) + '\n')
    expect(await store.meta!.get(s.id)).toEqual({ a: 1 })
  })

  it('мета не узел ленты, дальнейший appendNode подвешен к сообщению', async () => {
    const { store } = fresh()
    const s = await store.create()
    const u = await store.appendNode(s.id, { role: 'user', text: 'q' })
    await store.meta!.set!(s.id, { x: 1 })
    const a = await store.appendNode(s.id, { role: 'assistant', text: 'a' })
    expect(a.parent).toBe(u.id)
    const model = await store.load(s.id)
    expect(model.nodes.map((n) => [n.id, n.parent])).toEqual([
      [u.id, null],
      [a.id, u.id],
    ])
    expect((await store.list()).sessions[0]!.messageCount).toBe(2)
  })

  it('ветвление: мета одной ветки не видна на соседней; свайп назад возвращает её', async () => {
    const { store } = fresh()
    const s = await store.create()
    const u = await store.appendNode(s.id, { role: 'user', text: 'q' })
    const a1 = await store.appendNode(s.id, { role: 'assistant', text: 'a1' })
    await store.meta!.set!(s.id, { branch: 'a1' })

    const a2 = await store.appendNode(s.id, { role: 'assistant', text: 'a2', parent: u.id })
    await store.setActiveLeaf!(s.id, a2.id)
    expect(await store.meta!.get(s.id)).toEqual({})
    await store.meta!.set!(s.id, { branch: 'a2' })
    expect(await store.meta!.get(s.id)).toEqual({ branch: 'a2' })

    await store.setActiveLeaf!(s.id, a1.id)
    expect(await store.meta!.get(s.id)).toEqual({ branch: 'a1' })
    // Активный лист ленты — a1 (meta.activeLeaf; узлы — по времени записи), новый узел — его ребёнок.
    expect((await store.load(s.id)).meta?.activeLeaf).toBe(a1.id)
    const next = await store.appendNode(s.id, { role: 'user', text: 'дальше' })
    expect(next.parent).toBe(a1.id)
    expect(await store.meta!.get(s.id)).toEqual({ branch: 'a1' })

    await store.setActiveLeaf!(s.id, a2.id)
    expect(await store.meta!.get(s.id)).toEqual({ branch: 'a2' })
  })

  it('без hide — meta/choices нет', async () => {
    const store = createPiStore({ dir: mkdtempSync(join(tmpdir(), 'pi-meta-')) })
    expect(store.meta).toBeUndefined()
    expect(store.choices).toBeUndefined()
    expect((await store.capabilities()).sessionMeta).toBeUndefined()
  })
})

describe('pi hide: choices', () => {
  it('модель — model_change/thinking_level_change, профиль — custom nr-session-profile {name}', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    expect(await store.choices!.get(s.id)).toEqual({})
    await store.appendNode(s.id, { role: 'user', text: 'q' })
    await store.choices!.set(s.id, { model: { provider: 'nr', model: 'glm-5', thinking: 'high' }, profile: 'writer' })
    expect(await store.choices!.get(s.id)).toEqual({ model: { provider: 'nr', model: 'glm-5', thinking: 'high' }, profile: 'writer' })

    const svc = lines(dir).slice(1)
    expect(svc.map(({ id: _i, parentId: _p, timestamp: _t, ...rest }) => rest)).toEqual([
      { type: 'model_change', provider: 'nr', modelId: 'glm-5' },
      { type: 'thinking_level_change', thinkingLevel: 'high' },
      { type: 'custom', customType: 'nr-session-profile', data: { name: 'writer' } },
    ])
    // Цепочка ребёнком листа, лента не тронута.
    expect(svc[1]!.parentId).toBe(svc[0]!.id)
    expect((await store.load(s.id)).nodes).toHaveLength(1)

    // То же самое повторно — ничего не пишется; смена — только изменившееся.
    await store.choices!.set(s.id, { model: { provider: 'nr', model: 'glm-5', thinking: 'high' }, profile: 'writer' })
    expect(lines(dir)).toHaveLength(4)
    await store.choices!.set(s.id, { model: { provider: 'nr', model: 'glm-6', thinking: 'high' } })
    expect(lines(dir).slice(4).map((e) => e.type)).toEqual(['model_change'])
    expect(await store.choices!.get(s.id)).toEqual({ model: { provider: 'nr', model: 'glm-6', thinking: 'high' }, profile: 'writer' })
  })

  it('без provider — поле не пишется; встроенный профиль читается как inline; выбор ветвится', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    const u = await store.appendNode(s.id, { role: 'user', text: 'q' })
    await store.appendNode(s.id, { role: 'assistant', text: 'a1' })
    await store.choices!.set(s.id, { model: { model: 'm1' } })
    expect(lines(dir).at(-1)).not.toHaveProperty('provider')
    expect(await store.choices!.get(s.id)).toEqual({ model: { model: 'm1' } })

    const a2 = await store.appendNode(s.id, { role: 'assistant', text: 'a2', parent: u.id })
    await store.setActiveLeaf!(s.id, a2.id)
    expect(await store.choices!.get(s.id)).toEqual({})

    // Встроенный профиль (backend-pi пишет {doc}) — 'inline'.
    const file = readdirSync(dir).find((n) => n.endsWith('.jsonl'))!
    const inline = { type: 'custom', id: 'prof0001', parentId: a2.id, timestamp: 't', customType: 'nr-session-profile', data: { doc: { name: 'Бот' } } }
    writeFileSync(join(dir, file), readFileSync(join(dir, file), 'utf-8') + JSON.stringify(inline) + '\n')
    expect(await store.choices!.get(s.id)).toEqual({ profile: 'inline' })
  })
})

describe('pi: кэш list()', () => {
  const header = (id: string) => JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/w' })
  const msg = (id: string, parentId: string | null) => JSON.stringify({ type: 'message', id, parentId, timestamp: 't', message: { role: 'user', content: 'q' } })

  it('изменение файла извне видно, удалённый исчезает, новый появляется (с id в имени и без)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-cache-'))
    const named = join(dir, '2026-01-01T00-00-00-000Z_sess-a.jsonl')
    writeFileSync(named, `${header('sess-a')}\n${msg('m1', null)}\n`)
    writeFileSync(join(dir, 'noid.jsonl'), `${header('sess-b')}\n`)
    const store = createPiStore({ dir, piServiceEntries: 'hide' })
    const counts = async () => Object.fromEntries((await store.list()).sessions.map((x) => [x.id, x.messageCount]))
    expect(await counts()).toEqual({ 'sess-a': 1, 'sess-b': 0 })

    // Дописали извне — тот же mtime (грубое разрешение ФС), но другой размер.
    const before = (await store.list()).sessions.find((x) => x.id === 'sess-a')!
    writeFileSync(named, `${header('sess-a')}\n${msg('m1', null)}\n${msg('m2', 'm1')}\n`)
    const t = new Date(before.updatedAt!)
    utimesSync(named, t, t)
    expect(await counts()).toEqual({ 'sess-a': 2, 'sess-b': 0 })

    rmSync(join(dir, 'noid.jsonl'))
    writeFileSync(join(dir, 'other.jsonl'), `${header('sess-c')}\n${msg('x', null)}\n`)
    expect(await counts()).toEqual({ 'sess-a': 2, 'sess-c': 1 })
  })

  it('собственные записи (append/rename/meta/delete/fork) сразу видны в list', async () => {
    const { store } = fresh()
    const s = await store.create()
    expect((await store.list()).sessions.map((x) => x.messageCount)).toEqual([0])
    await store.appendNode(s.id, { role: 'user', text: 'q' })
    await store.rename!(s.id, 'Имя')
    await store.meta!.set!(s.id, { a: 1 })
    const [info] = (await store.list()).sessions
    expect(info).toMatchObject({ id: s.id, messageCount: 1, title: 'Имя' })
    const f = await store.forkCopy!(s.id)
    expect((await store.list()).sessions.map((x) => x.id).sort()).toEqual([s.id, f.id].sort())
    await store.delete!(s.id)
    expect((await store.list()).sessions.map((x) => x.id)).toEqual([f.id])
  })
})
