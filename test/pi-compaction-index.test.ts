/**
 * pi-драйвер (DEV-200): узел компакции в формате pi (`compaction.append`),
 * его вид в сборке (`compactedView` / `applyCompaction` — семантика
 * `buildContextEntries` pi) и индекс метаданных для холодного `list()`.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPiStore, LIST_INDEX_FILE } from '../src/pi/index.js'
import { applyCompaction, compactedView, compactionData, compactionPart, COMPACTION_HINT } from '../src/assembly/index.js'
import { activePath, resolveTree } from '../src/index.js'

type Line = Record<string, unknown> & { type: string; id: string; parentId: string | null }

function lines(dir: string): Line[] {
  const file = readdirSync(dir).find((n) => n.endsWith('.jsonl'))!
  return readFileSync(join(dir, file), 'utf-8')
    .trim()
    .split('\n')
    .slice(1)
    .map((l) => JSON.parse(l) as Line)
}

describe('pi: compaction.append', () => {
  it('пишет запись compaction pi ребёнком листа; узел — system с custom pi.compaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-compact-'))
    const store = createPiStore({ dir, piServiceEntries: 'hide' })
    const s = await store.create()
    const u1 = await store.appendNode(s.id, { role: 'user', text: 'раз' })
    await store.appendNode(s.id, { role: 'assistant', text: 'ответ 1' })
    const u2 = await store.appendNode(s.id, { role: 'user', text: 'два' })
    const a2 = await store.appendNode(s.id, { role: 'assistant', text: 'ответ 2' })

    const node = await store.compaction!.append(s.id, {
      summary: '## Goal\nтест',
      firstKeptEntryId: u2.id,
      tokensBefore: 1234,
      details: { readFiles: ['a.ts'], modifiedFiles: [] },
      usage: { input: 10, output: 5 },
    })
    expect(node.role).toBe('system')
    expect(node.parent).toBe(a2.id)
    expect(compactionData(node)).toEqual({ summary: '## Goal\nтест', firstKeptEntryId: u2.id, tokensBefore: 1234, details: { readFiles: ['a.ts'], modifiedFiles: [] } })
    expect(node.parts[0]).toMatchObject({ type: 'custom', text: '## Goal\nтест', meta: { hint: COMPACTION_HINT } })

    // Нативная запись pi (appendCompaction): поля и порядок цепочки.
    const last = lines(dir).at(-1)!
    expect(last).toMatchObject({ type: 'compaction', parentId: a2.id, summary: '## Goal\nтест', firstKeptEntryId: u2.id, tokensBefore: 1234 })
    expect((last.usage as { totalTokens: number }).totalTokens).toBe(15)
    expect(last).not.toHaveProperty('nrsRole')

    // Следующий ответ — ребёнок компакции; активный путь видит её узлом.
    const a3 = await store.appendNode(s.id, { role: 'assistant', text: 'после' })
    const model = await store.load(s.id)
    const path = activePath(model, resolveTree(model.nodes))
    expect(path.map((n) => n.id)).toEqual([u1.id, expect.any(String), u2.id, a2.id, node.id, a3.id])
    // Видимое модели: компакция, хвост от firstKept, всё после.
    expect(applyCompaction(path, { params: {}, mode: 'live' }).map((n) => n.id)).toEqual([node.id, u2.id, a2.id, a3.id])
  })

  it('parent — явный родитель (ветка от него)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-compact-'))
    const store = createPiStore({ dir })
    const s = await store.create()
    const u1 = await store.appendNode(s.id, { role: 'user', text: 'раз' })
    await store.appendNode(s.id, { role: 'assistant', text: 'ответ' })
    const node = await store.compaction!.append(s.id, { summary: 'S', firstKeptEntryId: u1.id, tokensBefore: 1, parent: u1.id })
    expect(node.parent).toBe(u1.id)
    await expect(store.compaction!.append(s.id, { summary: 'S', firstKeptEntryId: u1.id, tokensBefore: 1, parent: 'nope' })).rejects.toThrow()
  })
})

describe('assembly: compactedView', () => {
  const m = (id: string, role = 'user') => ({ id, role, parts: [{ type: 'text' as const, text: id }] })
  const c = (id: string, firstKeptEntryId: string) => ({ id, role: 'system', parts: [compactionPart({ summary: `S${id}`, firstKeptEntryId, tokensBefore: 5 })] })

  it('без компакции — путь как есть', () => {
    const path = [m('a'), m('b', 'assistant')]
    expect(compactedView(path)).toEqual({ items: path })
  })

  it('последняя компакция пути; firstKept не на пути — хвоста нет', () => {
    const path = [m('a'), m('b', 'assistant'), c('c1', 'b'), m('d'), m('e', 'assistant'), c('c2', 'd'), m('f')]
    const v = compactedView(path)
    expect(v.items.map((x) => x.id)).toEqual(['c2', 'd', 'e', 'f'])
    expect(v.compaction).toMatchObject({ index: 5, data: { summary: 'Sc2', firstKeptEntryId: 'd' } })
    expect(compactedView([m('a'), c('c', 'zzz'), m('b')]).items.map((x) => x.id)).toEqual(['c', 'b'])
  })

  it('чистота: вход не мутируется', () => {
    const path = [m('a'), c('c', 'a'), m('b')]
    const before = JSON.stringify(path)
    compactedView(path)
    expect(JSON.stringify(path)).toBe(before)
  })
})

describe('pi: индекс list() на диске (listIndex)', () => {
  /** Сессии каталога, записанные напрямую (как их пишет pi). */
  function seed(dir: string, n: number, bodyChars: number): void {
    const body = 'x'.repeat(bodyChars)
    for (let i = 0; i < n; i++) {
      const id = `0190a000-0000-7000-8000-${String(i).padStart(12, '0')}`
      const ts = new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString()
      const out = [JSON.stringify({ type: 'session', version: 3, id, timestamp: ts, cwd: '/w' })]
      let parent: string | null = null
      for (let j = 0; j < 20; j++) {
        const eid = `e${i}x${j}`
        const role = j % 2 ? 'assistant' : 'user'
        out.push(JSON.stringify({ type: 'message', id: eid, parentId: parent, timestamp: ts, message: { role, content: [{ type: 'text', text: `${j} ${body}` }], timestamp: 0 } }))
        parent = eid
      }
      out.push(JSON.stringify({ type: 'session_info', id: `t${i}`, parentId: parent, timestamp: ts, name: `сессия ${i}` }))
      writeFileSync(join(dir, `${ts.replace(/[:.]/g, '-')}_${id}.jsonl`), out.join('\n') + '\n')
    }
  }

  it('холодный старт читает индекс; перечитывается только изменённый файл', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-index-'))
    seed(dir, 12, 50)
    // mtime с точностью до секунды: utimes ниже восстановит его бит-в-бит.
    const fixed = new Date(Date.UTC(2026, 9, 2))
    for (const n of readdirSync(dir)) utimesSync(join(dir, n), fixed, fixed)
    const warm = createPiStore({ dir, piServiceEntries: 'hide', listIndex: true })
    const first = await warm.list()
    expect(first.sessions).toHaveLength(12)
    expect(existsSync(join(dir, LIST_INDEX_FILE))).toBe(true)
    // Индекс — не сессия: list его не видит.
    expect((await warm.list()).sessions).toHaveLength(12)

    // Холодный процесс: файл сессий испорчен так, что разбор его упал бы, — но mtime/size совпадают с индексом.
    const files = readdirSync(dir).filter((n) => n.endsWith('.jsonl'))
    const victim = join(dir, files[0]!)
    const text = readFileSync(victim, 'utf-8')
    writeFileSync(victim, 'Z'.repeat(Buffer.byteLength(text)))
    utimesSync(victim, fixed, fixed)
    const cold = createPiStore({ dir, piServiceEntries: 'hide', listIndex: true })
    const again = await cold.list()
    expect(again.sessions.map((x) => [x.id, x.title, x.messageCount])).toEqual(first.sessions.map((x) => [x.id, x.title, x.messageCount]))

    // Изменённый mtime — файл перечитывается (а битый выпадает из списка).
    utimesSync(victim, fixed, new Date(fixed.getTime() + 5000))
    const third = createPiStore({ dir, piServiceEntries: 'hide', listIndex: true })
    expect((await third.list()).sessions).toHaveLength(11)
  })

  it('свой путь индекса; без listIndex файла нет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-index-'))
    seed(dir, 2, 10)
    await createPiStore({ dir }).list()
    expect(existsSync(join(dir, LIST_INDEX_FILE))).toBe(false)
    const custom = join(mkdtempSync(join(tmpdir(), 'pi-index-out-')), 'idx.json')
    await createPiStore({ dir, listIndex: custom }).list()
    expect(JSON.parse(readFileSync(custom, 'utf-8')).version).toBe(1)
  })

  it('замер: холодный list() по индексу на 150 сессиях < 500 мс', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-index-perf-'))
    seed(dir, 150, 20_000)
    const t0 = performance.now()
    await createPiStore({ dir, piServiceEntries: 'hide', listIndex: true }).list()
    const noIndex = performance.now() - t0
    const t1 = performance.now()
    const r = await createPiStore({ dir, piServiceEntries: 'hide', listIndex: true }).list()
    const withIndex = performance.now() - t1
    expect(r.sessions).toHaveLength(150)
    console.log(`list() 150 сессий (~400 КБ каждая): без индекса ${noIndex.toFixed(0)} мс, холодный по индексу ${withIndex.toFixed(0)} мс`)
    expect(withIndex).toBeLessThan(500)
  })
})
