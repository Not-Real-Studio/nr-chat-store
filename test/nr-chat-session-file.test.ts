/**
 * Драйвер nr-chat как стор стенда (DEV-237, nr-driver-switch-spec §1, §4):
 * всё уровня файла — в шапке `%meta` (мета сессии, персоны, выбор модели и
 * профиля, бот), рецепт и тексты — sidecar (DEV-243). Форк и смена ветки
 * шапку не теряют — «мета по ветке» pi закрыта по построению.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNrChatStore, EFFECTIVE_PROMPT_FILE, PROMPTS_SUBDIR } from '../src/nr-chat/index.js'
import { compactionData } from '../src/assembly/engine.js'
import { toHistory } from '../src/tree.js'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'nr-chat-file-'))
  return { dir, store: createNrChatStore({ dir }) }
}

const fileOf = (dir: string, id: string) => readFileSync(join(dir, `${id}.mds`), 'utf-8')

const PERSONAS = { personas: [{ id: 'roxie', kind: 'char', name: 'Roxie', avatar: '' }, { id: 'max', kind: 'user', name: 'Макс' }], userId: 'max' }

describe('nr-chat: sessionMeta в шапке', () => {
  it('setActiveLeaf (свайп) не теряет мету, персоны и выбор', async () => {
    const { dir, store } = fresh()
    const s = await store.create({ info: { title: 'RP' } })
    const g0 = await store.appendNode(s.id, { role: 'assistant', text: 'g0' })
    const g1 = await store.appendNode(s.id, { role: 'assistant', text: 'g1', parent: null })
    await store.meta!.patch(s.id, { persona: { user: 'Макс' }, lorebook: { entries: [] } })
    await store.personas!.set(s.id, PERSONAS)
    await store.choices!.set(s.id, { model: { model: 'mac/heretic' }, profile: 'rp' })
    await store.setActiveLeaf!(s.id, g0.id)
    await store.setActiveLeaf!(s.id, g1.id)
    expect(await store.meta!.get(s.id)).toEqual({ persona: { user: 'Макс' }, lorebook: { entries: [] } })
    expect(await store.personas!.get(s.id)).toEqual(PERSONAS)
    expect(await store.choices!.get(s.id)).toEqual({ model: { model: 'mac/heretic' }, profile: 'rp' })
    // Одна шапка: всё уровня файла — в `%meta`, служебных узлов нет.
    const text = fileOf(dir, s.id)
    expect(text.split('\n')[0]).toMatch(/^%meta \{/)
    expect(text).not.toMatch(/nrs[A-Z]/)
    expect((await store.load(s.id)).nodes.map((n) => n.role)).toEqual(['assistant', 'assistant'])
  })

  it('forkCopy: шапка переезжает (мета, персоны с аватаром, выбор, бот), id узлов сохраняются', async () => {
    const { dir, store } = fresh()
    const s = await store.create({ info: { title: 'RP' } })
    const avatar = await store.assets!.put(s.id, 'roxie.png', new Uint8Array([1, 2, 3]))
    const a = await store.appendNode(s.id, { role: 'assistant', text: 'привет' })
    const u = await store.appendNode(s.id, { role: 'user', text: 'и тебе' })
    await store.appendNode(s.id, { role: 'assistant', text: 'хвост' })
    await store.meta!.patch(s.id, { prompt: { pre: 'свой' } })
    await store.personas!.set(s.id, { ...PERSONAS, personas: [{ ...PERSONAS.personas[0], avatar: avatar.ref }, PERSONAS.personas[1]] })
    await store.choices!.set(s.id, { profile: 'inline', profileDoc: { id: 'x', name: 'Inline', systemPrompt: 'sp' } as never })

    const fork = await store.forkCopy!(s.id, u.id)
    expect(fork.botName).toBe('Roxie')
    expect(await store.meta!.get(fork.id)).toEqual({ prompt: { pre: 'свой' } })
    const personas = await store.personas!.get(fork.id)
    expect((personas.personas[0] as { avatar: string }).avatar).toBe(`file:${fork.id}.assets/roxie.png`)
    expect(existsSync(join(dir, `${fork.id}.assets`, 'roxie.png'))).toBe(true)
    expect(await store.choices!.get(fork.id)).toEqual({ profile: 'inline', profileDoc: { id: 'inline', name: 'Inline', systemPrompt: 'sp' } })
    const model = await store.load(fork.id)
    expect(model.nodes.map((n) => n.id)).toEqual([a.id, u.id])
    expect(model.info.parentSessionId).toBe(s.id)
    expect(model.info.botAvatar).toBe(`file:${fork.id}.assets/roxie.png`)
  })

  it('meta.set — документ целиком (ключ снимается)', async () => {
    const { store } = fresh()
    const s = await store.create()
    await store.meta!.patch(s.id, { a: 1, b: 2 })
    await store.meta!.set!(s.id, { a: 1 })
    expect(await store.meta!.get(s.id)).toEqual({ a: 1 })
  })

  it('choices: одинаковое не пишется, профиль каталога снимает встроенный документ', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    await store.choices!.set(s.id, { profile: 'inline', profileDoc: { id: 'inline', name: 'I' } as never })
    await store.choices!.set(s.id, { profile: 'rp' })
    expect(await store.choices!.get(s.id)).toEqual({ profile: 'rp' })
    const before = fileOf(dir, s.id)
    await store.choices!.set(s.id, { profile: 'rp' })
    expect(fileOf(dir, s.id)).toBe(before)
  })
})

describe('nr-chat: рецепты, effectivePrompt, компакция', () => {
  it('рецепт и тексты — sidecar (DEV-243: не в маркере узла), в модели/проводе не виден; форк копирует оба', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    const u = await store.appendNode(s.id, { role: 'user', text: 'q' })
    const a = await store.appendNode(s.id, { role: 'assistant', text: 'a', meta: { personaId: 'roxie' } })
    await store.recipes!.put(s.id, { forMessageId: a.id, systemHash: 'abc123', messageIds: [u.id], injections: [{ role: 'user', hash: 'def456' }] }, new Map([['abc123', 'SYSTEM'], ['def456', 'POST']]))
    const got = await store.recipes!.get(s.id, a.id)
    expect(got?.data).toEqual({ forMessageId: a.id, systemHash: 'abc123', messageIds: [u.id], injections: [{ role: 'user', hash: 'def456' }] })
    expect(Object.fromEntries(got!.texts)).toEqual({ abc123: 'SYSTEM', def456: 'POST' })
    const model = await store.load(s.id)
    expect(model.nodes.find((n) => n.id === a.id)!.meta).toEqual({ personaId: 'roxie' })
    expect(toHistory(model)[1]!.meta).toEqual({ personaId: 'roxie' })
    expect(readdirSync(join(dir, `${s.id}.assets`, PROMPTS_SUBDIR)).sort()).toEqual(['abc123.md', 'def456.md', 'recipes'])
    expect(readdirSync(join(dir, `${s.id}.assets`, PROMPTS_SUBDIR, 'recipes'))).toEqual([`${a.id}.json`])
    expect(fileOf(dir, s.id)).not.toContain('recipe')

    const fork = await store.forkCopy!(s.id)
    const inFork = await store.recipes!.get(fork.id, a.id)
    expect(inFork?.texts.get('abc123')).toBe('SYSTEM')
  })

  it('effectivePrompt — файл, не память процесса', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    expect(await store.recipes!.effective!.get(s.id)).toBeUndefined()
    await store.recipes!.effective!.set(s.id, '%system\nS\n')
    expect(await createNrChatStore({ dir }).recipes!.effective!.get(s.id)).toBe('%system\nS\n')
    expect(existsSync(join(dir, `${s.id}.assets`, PROMPTS_SUBDIR, EFFECTIVE_PROMPT_FILE))).toBe(true)
  })

  it('компакция — узел system с частью pi.compaction (сборка читает её как у pi)', async () => {
    const { store } = fresh()
    const s = await store.create()
    const u = await store.appendNode(s.id, { role: 'user', text: 'q' })
    const node = await store.compaction!.append(s.id, { summary: 'S', firstKeptEntryId: u.id, tokensBefore: 100, usage: { input: 5, output: 3 } })
    expect(node.role).toBe('system')
    expect(compactionData(node)).toEqual({ summary: 'S', firstKeptEntryId: u.id, tokensBefore: 100 })
    expect(node.meta).toEqual({ usage: { input: 5, output: 3 } })
  })

  it('запись атомарная: временных файлов не остаётся', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    for (let i = 0; i < 5; i++) await store.appendNode(s.id, { role: 'user', text: `m${i}` })
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('параллельные записи одной сессии не теряют правки (очередь записей)', async () => {
    const { store } = fresh()
    const s = await store.create()
    await Promise.all([
      store.rename!(s.id, 'T'),
      store.meta!.patch(s.id, { a: 1 }),
      store.personas!.set(s.id, PERSONAS),
      store.appendNode(s.id, { role: 'user', text: 'x' }),
      store.choices!.set(s.id, { profile: 'rp' }),
    ])
    const m = await store.load(s.id)
    expect(m.info.title).toBe('T')
    expect(m.nodes).toHaveLength(1)
    expect(await store.meta!.get(s.id)).toEqual({ a: 1 })
    expect((await store.personas!.get(s.id)).userId).toBe('max')
    expect((await store.choices!.get(s.id)).profile).toBe('rp')
  })

  it('мета вложения сверх ref/mime (role: avatar) переживает запись и чтение', async () => {
    const { store } = fresh()
    const s = await store.create()
    const n = await store.appendNode(s.id, { role: 'user', parts: [{ type: 'image', meta: { ref: 'file:x.assets/a.png', mime: 'image/png', alt: 'a.png', role: 'avatar' } } as never] })
    expect(n.parts[0]).toEqual({ type: 'image', meta: { ref: 'file:x.assets/a.png', mime: 'image/png', alt: 'a.png', role: 'avatar' } })
  })
})

describe('nr-chat: рецепт в мете маркера (до DEV-243)', () => {
  it('читается; новый put уносит его из маркера в sidecar', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    const a = await store.appendNode(s.id, { role: 'assistant', text: 'a' })
    const path = join(dir, `${s.id}.mds`)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(path, fileOf(dir, s.id).replace(`{id: '${a.id}'}`, `{id: '${a.id}', recipe: {systemHash: 'aa', messageIds: [], injections: []}}`))
    expect((await store.recipes!.get(s.id, a.id))?.data.systemHash).toBe('aa')
    await store.recipes!.put(s.id, { forMessageId: a.id, systemHash: 'bb', messageIds: [], injections: [] }, new Map())
    expect(fileOf(dir, s.id)).not.toContain('recipe')
    expect((await store.recipes!.get(s.id, a.id))?.data.systemHash).toBe('bb')
  })
})
