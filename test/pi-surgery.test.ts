/**
 * pi — настоящая line surgery (spec §4). Парсер хранит raw каждой строки (вкл.
 * невалидные/чужие); мутация пересериализует ТОЛЬКО затронутые entries, остальное
 * (чужие пробелы, malformed-строки) пишется байт-в-байт verbatim.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPiStore } from '../src/pi/index.js'

const HEADER = '{"type":"session","version":3,"id":"surg-sess","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/w"}'
// Entry A written with foreign, non-canonical whitespace (spaces after colons/commas).
const A_RAW =
  '{"type": "message", "id": "aaaa", "parentId": null, "timestamp": "2026-01-01T00:00:01.000Z", "message": {"role": "user", "content": "hi A"}}'
const MALFORMED = 'this is }{ not valid json at all <<<'
const B_RAW =
  '{"type":"message","id":"bbbb","parentId":"aaaa","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":"hi B"}}'

function seed(): { dir: string; store: ReturnType<typeof createPiStore> } {
  const dir = mkdtempSync(join(tmpdir(), 'pi-surg-'))
  writeFileSync(join(dir, 'surg.jsonl'), [HEADER, A_RAW, MALFORMED, B_RAW, ''].join('\n'), 'utf-8')
  return { dir, store: createPiStore({ dir, cwd: '/w' }) }
}

const lines = (dir: string): string[] =>
  readFileSync(join(dir, 'surg.jsonl'), 'utf-8').split('\n').filter((l) => l.trim() !== '')

describe('pi line surgery (§4)', () => {
  it('чужие пробелы в незатронутой строке выживают мутацию соседа', async () => {
    const { dir, store } = seed()
    await store.editNode('surg-sess', 'bbbb', { text: 'edited B' })
    const after = lines(dir)
    // Строка A (с чужими пробелами) — байт-в-байт как была.
    expect(after).toContain(A_RAW)
    // Затронутая строка B — пересериализована (её прежний вид исчез).
    expect(after).not.toContain(B_RAW)
    expect(after.some((l) => l.includes('edited B'))).toBe(true)
  })

  it('malformed-строка выживает мутацию соседней записи', async () => {
    const { dir, store } = seed()
    await store.editNode('surg-sess', 'aaaa', { text: 'edited A' })
    const after = lines(dir)
    // Битая строка сохранена дословно и на своём месте (после A, перед B).
    expect(after).toContain(MALFORMED)
    expect(after.indexOf(MALFORMED)).toBeGreaterThan(after.findIndex((l) => l.includes('edited A')))
    expect(after.indexOf(MALFORMED)).toBeLessThan(after.findIndex((l) => l.includes('hi B')))
    // Нетронутая B — verbatim.
    expect(after).toContain(B_RAW)
  })

  it('load игнорирует malformed-строку, но видит обе валидные записи', async () => {
    const { store } = seed()
    const model = await store.load('surg-sess')
    expect(model.nodes.map((n) => n.id)).toEqual(['aaaa', 'bbbb'])
  })
})
