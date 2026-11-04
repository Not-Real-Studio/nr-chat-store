// DEV-645: дозапись вместо перезаписи, кэш разбора, склейка проходов списка.
import { appendFileSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNrChatStore } from '../src/nr-chat/index.js'

const text = (t: string) => [{ type: 'text' as const, text: t }]

describe('DEV-645: nr-chat запись и список', () => {
  it('новый узел дописывается в тот же файл (inode не меняется), последний узел — с частями', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev645-'))
    const s = createNrChatStore({ dir })
    const { id } = await s.create({})
    await s.appendNode(id, { role: 'user', text: 'раз' })
    const file = join(dir, `${id}.mds`)
    const ino = statSync(file).ino
    const n = await s.appendNode(id, { role: 'assistant', text: 'два' })
    expect(statSync(file).ino).toBe(ino)
    expect(n.parts).toEqual(text('два'))
    const m = await s.load(id)
    expect(m.nodes.map((x) => x.role)).toEqual(['user', 'assistant'])
  })

  it('чужая правка файла между шагами — кэш не врёт, запись целиком', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev645-'))
    const s = createNrChatStore({ dir })
    const { id } = await s.create({})
    await s.appendNode(id, { role: 'user', text: 'раз' })
    const file = join(dir, `${id}.mds`)
    appendFileSync(file, '%user {id: \'ext1\'}\nснаружи\n')
    await s.appendNode(id, { role: 'assistant', text: 'два' })
    const m = await s.load(id)
    expect(m.nodes.map((x) => x.parts[0]?.type === 'text' ? (x.parts[0] as { text: string }).text.trim() : '')).toEqual(['раз', 'снаружи', 'два'])
    writeFileSync(file, readFileSync(file, 'utf8'))
  })

  it('параллельные list() — один проход, одинаковый результат', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dev645-'))
    const s = createNrChatStore({ dir, indexFile: true })
    for (let i = 0; i < 5; i++) await s.create({})
    const [a, b, c] = await Promise.all([s.list({}), s.list({}), s.list({})])
    expect(a.sessions.length).toBe(5)
    expect(b.sessions.map((x) => x.id)).toEqual(a.sessions.map((x) => x.id))
    expect(c.sessions.length).toBe(5)
  })
})
