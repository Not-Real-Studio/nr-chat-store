/** Файл-кэш индекса списка сессий (DEV-344): переживает рестарт, ловит смену mtime/размера. */
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNrChatStore } from '../src/nr-chat/index.js'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('indexFile', () => {
  it('кэш пишется рядом с каталогом, второй стор берёт из него; переименование видно сразу', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'list-index-'))
    const a = createNrChatStore({ dir, indexFile: true })
    const s = await a.create({ info: { title: 'Первый' } })
    expect((await a.list()).sessions.map((x) => x.title)).toEqual(['Первый'])
    await wait(400)
    const cache = join(dir, '.list-index.json')
    expect(existsSync(cache)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(cache, 'utf8'))['nr-chat/index3/' + dir.replace(/[^A-Za-z0-9._-]+/g, '_')].files)).toEqual([`${s.id}.mds`])

    // Рестарт: файл-кэш не даёт разбирать неизменённый файл — подменим текст кэша и увидим его.
    const key = 'nr-chat/index3/' + dir.replace(/[^A-Za-z0-9._-]+/g, '_')
    const raw = JSON.parse(readFileSync(cache, 'utf8'))
    raw[key].files[`${s.id}.mds`].info.title = 'Из кэша'
    writeFileSync(cache, JSON.stringify(raw))
    const b = createNrChatStore({ dir, indexFile: true })
    expect((await b.list()).sessions[0]?.title).toBe('Из кэша')

    // Переименование меняет файл (mtime/size) — запись пересчитана.
    await b.rename(s.id, 'Переименован')
    expect((await b.list()).sessions[0]?.title).toBe('Переименован')
    // Смена одного только mtime — тоже пересчёт.
    const file = join(dir, `${s.id}.mds`)
    writeFileSync(file, readFileSync(file, 'utf8').replace('Переименован', 'Переименовал'))
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect((await b.list()).sessions[0]?.title).toBe('Переименовал')
    // Новый файл — по листингу каталога.
    const n = await b.create({ info: { title: 'Новая' } })
    expect((await b.list()).sessions.map((x) => x.id)).toContain(n.id)
  })
})
