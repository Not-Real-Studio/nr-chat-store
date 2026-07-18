/**
 * Хирургия побайтово (spec §5, §8): записи, не затронутые операцией, в хранилище
 * не переписываются. mds — байты вне спанов идентичны; pi/claude — нетронутые
 * JSONL-строки verbatim.
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMdsStore } from '../src/mds/index.js'
import { createPiStore } from '../src/pi/index.js'
import { createClaudeStore } from '../src/claude/index.js'

function onlyFile(dir: string, ext: string): string {
  const name = readdirSync(dir).find((f) => f.endsWith(ext))!
  return join(dir, name)
}
const nonEmptyLines = (text: string): string[] => text.split('\n').filter((l) => l.trim() !== '')

describe('surgery: mds — байты вне спана нетронуты', () => {
  it('editNode(A) не переписывает строки B и C', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mds-'))
    const s = createMdsStore({ dir })
    const { id: sid } = await s.create({ id: 'x' })
    const a = await s.appendNode(sid, { role: 'user', text: 'A' })
    await s.appendNode(sid, { role: 'assistant', text: 'B' })
    await s.appendNode(sid, { role: 'user', text: 'C' })

    const before = readFileSync(join(dir, 'x.mds'), 'utf-8')
    await s.editNode(sid, a.id, { text: 'A-changed-longer' })
    const after = readFileSync(join(dir, 'x.mds'), 'utf-8')

    // Все строки, кроме тела ноды A, присутствуют в after дословно.
    for (const line of nonEmptyLines(before)) {
      if (line === 'A') continue // единственная затронутая строка (тело A)
      expect(after).toContain(line)
    }
    expect(after).toContain('A-changed-longer')
  })

  it('appendNode дописывает в конец — префикс байт стабилен', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mds-'))
    const s = createMdsStore({ dir })
    const { id: sid } = await s.create({ id: 'y' })
    await s.appendNode(sid, { role: 'user', text: 'первое' })
    const before = readFileSync(join(dir, 'y.mds'), 'utf-8')
    await s.appendNode(sid, { role: 'assistant', text: 'второе' })
    const after = readFileSync(join(dir, 'y.mds'), 'utf-8')
    expect(after.startsWith(before)).toBe(true)
  })
})

describe('surgery: pi — нетронутые JSONL-строки verbatim', () => {
  async function seed() {
    const dir = mkdtempSync(join(tmpdir(), 'pi-'))
    const s = createPiStore({ dir, cwd: '/w' })
    const { id: sid } = await s.create({})
    const a = await s.appendNode(sid, { role: 'user', text: 'A' })
    const b = await s.appendNode(sid, { role: 'assistant', text: 'B' })
    const c = await s.appendNode(sid, { role: 'user', text: 'C' })
    return { dir, s, sid, a, b, c }
  }
  const byId = (lines: string[]): Map<string, string> => {
    const m = new Map<string, string>()
    for (const l of lines) {
      try {
        const o = JSON.parse(l) as { id?: string }
        if (o.id) m.set(o.id, l)
      } catch {
        /* header */
      }
    }
    return m
  }

  it('editNode(B) меняет только строку B', async () => {
    const { dir, s, sid, a, b, c } = await seed()
    const path = onlyFile(dir, '.jsonl')
    const before = byId(nonEmptyLines(readFileSync(path, 'utf-8')))
    await s.editNode(sid, b.id, { text: 'B*' })
    const after = byId(nonEmptyLines(readFileSync(path, 'utf-8')))
    expect(after.get(a.id)).toBe(before.get(a.id))
    expect(after.get(c.id)).toBe(before.get(c.id))
    expect(after.get(b.id)).not.toBe(before.get(b.id))
  })

  it('setActiveLeaf переставляет строки, не меняя их байт', async () => {
    const { dir, s, sid, a } = await seed()
    const path = onlyFile(dir, '.jsonl')
    const alt = await s.appendNode(sid, { role: 'assistant', text: 'B2', parent: a.id })
    const before = nonEmptyLines(readFileSync(path, 'utf-8')).sort()
    await s.setActiveLeaf(sid, alt.id)
    const after = nonEmptyLines(readFileSync(path, 'utf-8')).sort()
    expect(after).toEqual(before) // множество строк идентично, изменился только порядок
  })
})

describe('surgery: claude — append-only, все прежние строки verbatim', () => {
  it('appendNode оставляет прежние строки байт-в-байт', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-'))
    const s = createClaudeStore({ dir, cwd: '/w' })
    const { id: sid } = await s.create({})
    await s.appendNode(sid, { role: 'user', text: 'первое' })
    const path = join(dir, `${sid}.jsonl`)
    const before = readFileSync(path, 'utf-8')
    await s.appendNode(sid, { role: 'assistant', text: 'второе' })
    const after = readFileSync(path, 'utf-8')
    expect(after.startsWith(before)).toBe(true)
  })
})
