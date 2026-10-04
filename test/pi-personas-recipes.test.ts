/**
 * pi-драйвер (`piServiceEntries: 'hide'`): персоны (`nr-session-personas`) и
 * рецепты промпта (`nr-prompt-recipe` + `<файл>.prompts/<hash>.md`) — формат,
 * который пишут forge/backend-pi/pi-ext-session-meta (DEV-222).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPiStore, PROMPTS_DIR_SUFFIX } from '../src/pi/index.js'

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-personas-'))
  return { dir, store: createPiStore({ dir, piServiceEntries: 'hide' }) }
}

const entries = (dir: string) => {
  const file = readdirSync(dir).find((n) => n.endsWith('.jsonl'))!
  return { file: join(dir, file), lines: readFileSync(join(dir, file), 'utf-8').trim().split('\n').slice(1).map((l) => JSON.parse(l) as Record<string, unknown>) }
}

describe('pi hide: personas', () => {
  it('get пустой → set → последний по ветке; запись custom nr-session-personas, в ленте её нет', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    expect(await store.personas!.get(s.id)).toEqual({ personas: [] })
    await store.appendNode(s.id, { role: 'assistant', text: 'привет' })
    const doc = { personas: [{ id: 'bot', kind: 'char', name: 'Scarlett' }, { id: 'me', kind: 'user', name: 'Ann', scenario: 'тайна' }], userId: 'me' }
    await store.personas!.set(s.id, doc)
    expect(await store.personas!.get(s.id)).toEqual(doc)
    const last = entries(dir).lines.at(-1)!
    expect(last).toMatchObject({ type: 'custom', customType: 'nr-session-personas', data: doc })
    expect((await store.load(s.id)).nodes.map((n) => n.role)).toEqual(['assistant'])
  })

  it('SessionInfo: бот сессии — первая char (имя и ref аватара), как у backend-pi', async () => {
    const { store } = fresh()
    const s = await store.create()
    await store.personas!.set(s.id, { personas: [{ id: 'me', kind: 'user', name: 'Ann' }, { id: 'bot', kind: 'char', name: 'Scarlett', avatar: 'files/a.png' }], userId: 'me' })
    const info = (await store.list()).sessions.find((x) => x.id === s.id)!
    expect(info.botName).toBe('Scarlett')
    expect(info.botAvatar).toBe('files/a.png')
    expect((await store.load(s.id)).info.botName).toBe('Scarlett')
  })
})

describe('pi hide: recipes', () => {
  it('put пишет запись ребёнком листа и тексты по хэшу; get — по forMessageId с текстами', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    await store.appendNode(s.id, { role: 'user', text: 'q' })
    const answer = await store.appendNode(s.id, { role: 'assistant', text: 'a' })
    const data = {
      forMessageId: answer.id,
      at: '2026-10-04T00:00:00.000Z',
      systemHash: 'aaaaaaaaaaaaaaaa',
      injections: [{ role: 'system', hash: 'bbbbbbbbbbbbbbbb', source: 'lorebook:bot: Butcher', reason: 'ключ «Rico»' }],
      systemBlocks: [{ source: 'meta.pre', hash: 'cccccccccccccccc' }],
      messageIds: [],
      personaId: 'bot',
    }
    const texts = new Map([
      ['aaaaaaaaaaaaaaaa', 'SYSTEM'],
      ['bbbbbbbbbbbbbbbb', 'LORE'],
      ['cccccccccccccccc', 'PRE'],
    ])
    await store.recipes!.put(s.id, data, texts)
    const { file, lines } = entries(dir)
    expect(lines.at(-1)).toMatchObject({ type: 'custom', customType: 'nr-prompt-recipe', parentId: answer.id, data })
    expect(existsSync(join(file + PROMPTS_DIR_SUFFIX, 'bbbbbbbbbbbbbbbb.md'))).toBe(true)

    const got = await store.recipes!.get(s.id, answer.id)
    expect(got?.data).toEqual(data)
    expect([...got!.texts.entries()].sort()).toEqual([...texts.entries()].sort())
    expect(await store.recipes!.get(s.id, 'nope')).toBeUndefined()
    // Служебная запись не в ленте; лист ленты — ответ.
    expect((await store.load(s.id)).nodes.map((n) => n.id).at(-1)).toBe(answer.id)
  })
})

describe('pi hide: кто сказал ответ и маркер «продолжай»', () => {
  it('personaId ответа — из рецепта (forMessageId); маркер nrContinue в ленте не виден', async () => {
    const { dir, store } = fresh()
    const s = await store.create()
    await store.appendNode(s.id, { role: 'user', text: 'q' })
    const a = await store.appendNode(s.id, { role: 'assistant', text: 'a' })
    await store.recipes!.put(s.id, { forMessageId: a.id, at: 'x', systemHash: 'aaaaaaaaaaaaaaaa', injections: [], messageIds: [], personaId: 'bot2' }, new Map())
    // Маркер pi-ext: user-сообщение с флагом, дописанное прямо в файл.
    const { writeFileSync, readFileSync: rf } = await import('node:fs')
    const { file, lines } = entries(dir)
    const marker = { type: 'message', id: 'mk000001', parentId: lines.at(-1)!.id, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Продолжай.', nrContinue: true, timestamp: 1 } }
    writeFileSync(file, rf(file, 'utf-8').trimEnd() + '\n' + JSON.stringify(marker) + '\n')
    const nodes = (await store.load(s.id)).nodes
    expect(nodes.find((n) => n.id === a.id)?.meta?.personaId).toBe('bot2')
    expect(nodes.map((n) => n.id)).not.toContain('mk000001')
  })
})
