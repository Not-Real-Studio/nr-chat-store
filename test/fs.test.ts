/**
 * DEV-226: носители без Node — пути, SHA-256, IFileSystem в памяти и над node:fs
 * (одна сюита на обе реализации), драйверы — без `node:*` в исходниках.
 */

import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as nodeJoin, posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { IFileSystem } from '@notrealstudio/nr-contracts'
import { createMemoryFileSystem, fsOf, fromBase64, isInside, join, normalize, relative, resolve, dirname, basename, sha256Hex, toBase64 } from '../src/fs/index.js'
import { createNodeFileSystem } from '../src/fs/node.js'

describe('path', () => {
  it('как path.posix', () => {
    for (const p of ['/a/b/../c', 'a/./b//c/', '/', '../x', 'a/../../b', '/a/..', '']) expect(normalize(p)).toBe(posix.normalize(p).replace(/(.)\/$/, '$1'))
    expect(join('/a', 'b', '../c')).toBe('/a/c')
    expect(resolve('/a', 'b', '/c', 'd')).toBe('/c/d')
    expect(dirname('/a/b/c.txt')).toBe('/a/b')
    expect(dirname('/a')).toBe('/')
    expect(basename('/a/b/c.txt')).toBe('c.txt')
    expect(relative('/a/b', '/a/c/d')).toBe('../c/d')
    expect(relative('/a', '/a')).toBe('')
    expect(isInside('/a', '/a/b')).toBe(true)
    expect(isInside('/a', '/ab')).toBe(false)
  })
  it('диск Windows и обратные слеши', () => {
    expect(normalize('C:\\x\\y\\..\\z')).toBe('C:/x/z')
    expect(resolve('C:/a', 'b')).toBe('C:/a/b')
    expect(dirname('C:/a')).toBe('C:/')
  })
})

describe('sha256/base64', () => {
  it('совпадает с node:crypto', () => {
    for (const s of ['', 'abc', 'привет', 'x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'q'.repeat(1000)]) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s).digest('hex'))
    }
    const bytes = new Uint8Array(70000).map((_, i) => (i * 31) & 255)
    expect(sha256Hex(bytes)).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes])
  })
})

const impls: Array<[string, () => { fs: IFileSystem; root: string }]> = [
  ['memory', () => ({ fs: createMemoryFileSystem(), root: '/r' })],
  ['node', () => ({ fs: createNodeFileSystem(), root: mkdtempSync(nodeJoin(tmpdir(), 'nrfs-')) })],
]

for (const [name, make] of impls) {
  describe(`IFileSystem: ${name}`, () => {
    it('файлы, каталоги, rename, remove, list', async () => {
      const { fs: raw, root } = make()
      const fs = fsOf(raw)
      expect(await fs.readText(`${root}/nope.txt`)).toBeUndefined()
      expect(await fs.stat(`${root}/nope`)).toBeUndefined()
      expect(await fs.readdir(`${root}/nope`)).toBeUndefined()
      await fs.writeText(`${root}/a/b/c.txt`, 'привет')
      expect(await fs.readText(`${root}/a/b/c.txt`)).toBe('привет')
      const st = await fs.stat(`${root}/a/b/c.txt`)
      expect(st).toMatchObject({ type: 'file', size: 12 })
      expect((await fs.stat(`${root}/a`))?.type).toBe('dir')
      await fs.writeBytes(`${root}/a/bin`, new Uint8Array([0, 1, 2]))
      expect([...((await fs.readBytes(`${root}/a/bin`)) ?? [])]).toEqual([0, 1, 2])
      expect((await fs.readdir(`${root}/a`))?.map((e) => `${e.name}:${e.type}`).sort()).toEqual(['b:dir', 'bin:file'])
      expect(await fs.list(`${root}/a`)).toEqual([`${root}/a/b/c.txt`, `${root}/a/bin`])
      await fs.rename(`${root}/a/b`, `${root}/x/y`)
      expect(await fs.readText(`${root}/x/y/c.txt`)).toBe('привет')
      expect(await fs.exists(`${root}/a/b`)).toBe(false)
      await fs.append(`${root}/x/y/c.txt`, '!')
      expect(await fs.readText(`${root}/x/y/c.txt`)).toBe('привет!')
      await fs.copyDir(`${root}/x`, `${root}/copy`)
      expect(await fs.readText(`${root}/copy/y/c.txt`)).toBe('привет!')
      await fs.remove(`${root}/x`, { recursive: true })
      expect(await fs.exists(`${root}/x/y/c.txt`)).toBe(false)
      await fs.remove(`${root}/never`)
      expect(await fs.realpath(`${root}/copy`)).toMatch(/copy$/)
    })
  })
}

describe('драйверы без node:*', () => {
  it('nr-chat, pi, fs/ (кроме node.ts), store.ts — ни одного node: импорта', () => {
    const src = nodeJoin(__dirname, '..', 'src')
    const files = [
      ...readdirSync(nodeJoin(src, 'nr-chat')).map((f) => nodeJoin(src, 'nr-chat', f)),
      ...readdirSync(nodeJoin(src, 'pi')).map((f) => nodeJoin(src, 'pi', f)),
      ...readdirSync(nodeJoin(src, 'fs')).filter((f) => f !== 'node.ts').map((f) => nodeJoin(src, 'fs', f)),
      nodeJoin(src, 'store.ts'),
      nodeJoin(src, 'memory', 'index.ts'),
    ]
    for (const f of files) expect(readFileSync(f, 'utf-8'), f).not.toMatch(/from 'node:|Buffer\.|process\./)
  })
})

describe('lore над IFileSystem', () => {
  it('книги профиля читаются с носителя, относительные — от base, ~ — от home', async () => {
    const { readProfileLore } = await import('../src/lore.js')
    const book = { entries: [{ keys: ['x'], content: 'X' }] }
    const fs = createMemoryFileSystem({ '/profiles/books/a.json': JSON.stringify(book), '/home/u/b.json': JSON.stringify(book) })
    const warns: string[] = []
    const lore = await readProfileLore(fs, { extra: { lorebook: 'books/a.json, ~/b.json, nope.json', lorebook_budget: '300' } }, '/profiles', { home: '/home/u', warn: (m) => warns.push(m) })
    expect(lore.books).toHaveLength(2)
    expect(lore.budget).toBe(300)
    expect(warns.join()).toMatch(/nope\.json/)
  })
})
