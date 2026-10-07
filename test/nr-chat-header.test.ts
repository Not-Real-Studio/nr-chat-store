/**
 * Шапка `%meta` человекочитаемая (DEV-243, ROADMAP «UI-пачка 4» п.0/0a):
 * персоны — `%%character <id> {kind, name, avatar, format}` телом (карта — mdd
 * через кодек, иначе json5), inline-профиль — `%%profile`, длинная мета сессии —
 * `%%<ключ>`; строка маркера — только короткое машинное. Старый вариант (всё в
 * строке маркера, DEV-237) читается и раскладывается первой правкой.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNrChatStore, readabilityViolations as humanReadableViolations, type CardCodec } from '../src/nr-chat/index.js'

const fileOf = (dir: string, id: string) => readFileSync(join(dir, `${id}.mds`), 'utf-8')

const LONG = 'Roxie is 25. '.repeat(60) + '\nSecond paragraph.\n\nThird.'
const CARD = {
  name: 'Roxie',
  description: LONG,
  personality: 'sharp\nwarm',
  scenario: 'August 1985, England.',
  first_mes: 'Hi {{user}}.',
  alternate_greetings: ['A', 'B\nC'],
  extensions: { nr: { greetings: [{ scenario: 'x' }] } },
}
const PERSONAS = {
  personas: [
    { id: 'roxie', kind: 'char', name: 'Roxie', avatar: 'file:x.assets/roxie.png', card: CARD },
    { id: 'max', kind: 'user', name: 'Макс', description: 'Высокий.\nУсталый.', gender: 'male' },
  ],
  userId: 'max',
}

/** Кодек-заглушка вместо mdd nr-cards: свой формат, тело — строки `ключ = json`. */
const fakeCodec: CardCodec = {
  format: 'kv',
  encode: (card) => Object.entries(card).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join('\n'),
  decode: (text) => Object.fromEntries(text.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf(' = ')), JSON.parse(l.slice(l.indexOf(' = ') + 3))])),
}

function fresh(cardCodec?: CardCodec) {
  const dir = mkdtempSync(join(tmpdir(), 'nr-chat-header-'))
  return { dir, store: createNrChatStore({ dir, cardCodec }) }
}

describe('nr-chat: шапка — персоны и длинная мета подузлами (DEV-243)', () => {
  it('персоны — %%character телом, маркер короткий; round-trip', async () => {
    const { dir, store } = fresh()
    const s = await store.create({ info: { title: 'RP' } })
    await store.appendNode(s.id, { role: 'assistant', text: 'привет' })
    await store.personas!.set(s.id, PERSONAS)
    await store.choices!.set(s.id, { model: { model: 'mac/heretic' }, profile: 'inline', profileDoc: { id: 'x', name: 'Inline', systemPrompt: 'Длинный\nпромпт' } as never })
    await store.meta!.patch(s.id, { persona: { user: 'Макс' }, prompt: { pre: 'свой\nпромпт' }, depthPrompt: { text: 'note', depth: 4 } })

    const text = fileOf(dir, s.id)
    expect(humanReadableViolations(text)).toEqual([])
    const lines = text.split('\n')
    expect(lines[0]).toMatch(/^%meta \{/)
    expect(lines[0]).toContain("userId: 'max'")
    // бот списка — из первой char-персоны, в маркере не дублируется
    expect(lines[0]).not.toContain('botName')
    expect((await store.list()).sessions.find((i) => i.id === s.id)).toMatchObject({ botName: 'Roxie', botAvatar: 'file:x.assets/roxie.png' })
    expect(lines[0]).not.toContain('personas')
    expect(text).toMatch(/^%%character roxie \{kind: 'char', name: 'Roxie', avatar: 'file:x\.assets\/roxie\.png', format: 'json5'\}$/m)
    expect(text).toMatch(/^%%character max \{kind: 'user', name: 'Макс', gender: 'male', format: 'json5'\}$/m)
    expect(text).toMatch(/^%%profile inline \{format: 'json5'\}$/m)
    expect(text).toMatch(/^%%prompt \{format: 'json5'\}$/m)
    // json5 с отступами — карта читается построчно
    expect(text).toContain("\n  card: {\n    name: 'Roxie',\n")

    expect(await store.personas!.get(s.id)).toEqual(PERSONAS)
    expect((await store.choices!.get(s.id)).profileDoc).toEqual({ id: 'inline', name: 'Inline', systemPrompt: 'Длинный\nпромпт' })
    // meta.get — мета сессии, без персон и профиля
    expect(await store.meta!.get(s.id)).toEqual({ persona: { user: 'Макс' }, prompt: { pre: 'свой\nпромпт' }, depthPrompt: { text: 'note', depth: 4 } })
    // история не задета
    expect((await store.load(s.id)).nodes.map((n) => n.role)).toEqual(['assistant'])
  })

  it('кодек карты: тело в его формате; кодек теряет поля — json5', async () => {
    const { dir, store } = fresh(fakeCodec)
    const s = await store.create({})
    await store.personas!.set(s.id, PERSONAS)
    const text = fileOf(dir, s.id)
    expect(text).toMatch(/^%%character roxie \{kind: 'char', name: 'Roxie', avatar: 'file:x\.assets\/roxie\.png', format: 'kv'\}\nname = "Roxie"$/m)
    // у user-персоны не только карта — json5
    expect(text).toMatch(/^%%character max \{.*format: 'json5'\}$/m)
    expect(await store.personas!.get(s.id)).toEqual(PERSONAS)

    const lossy: CardCodec = { ...fakeCodec, decode: (t) => ({ ...fakeCodec.decode(t), name: 'другое' }) }
    const b = fresh(lossy)
    const s2 = await b.store.create({})
    await b.store.personas!.set(s2.id, PERSONAS)
    expect(fileOf(b.dir, s2.id)).toMatch(/^%%character roxie \{.*format: 'json5'\}$/m)
  })

  it('стор без кодека не теряет тело чужого формата при перезаписи персон', async () => {
    const { dir, store } = fresh(fakeCodec)
    const s = await store.create({})
    await store.personas!.set(s.id, PERSONAS)
    const plain = createNrChatStore({ dir })
    const got = await plain.personas!.get(s.id)
    expect(got.personas[0]).toEqual({ id: 'roxie', kind: 'char', name: 'Roxie', avatar: 'file:x.assets/roxie.png' })
    // фронт правит имя user-персоны и шлёт документ целиком (карты roxie в нём нет)
    await plain.personas!.set(s.id, { ...got, personas: [got.personas[0], { ...got.personas[1], name: 'Макс 2' }] })
    expect((await store.personas!.get(s.id)).personas[0]).toEqual(PERSONAS.personas[0])
  })

  it('неизменённые подузлы — байтами как были (ручная правка цела)', async () => {
    const { dir, store } = fresh()
    const s = await store.create({})
    await store.personas!.set(s.id, PERSONAS)
    const path = join(dir, `${s.id}.mds`)
    // человек переформатировал тело карты руками — то же значение
    const edited = fileOf(dir, s.id).replace("    name: 'Roxie',\n", "    name:   'Roxie',   // имя\n")
    writeFileSync(path, edited)
    await store.meta!.patch(s.id, { persona: { user: 'Макс' } })
    await store.rename!(s.id, 'Новое имя')
    expect(fileOf(dir, s.id)).toContain("name:   'Roxie',   // имя")
  })

  it('старый вариант (DEV-237: всё в строке %meta) читается, первая правка раскладывает', async () => {
    const { dir, store } = fresh()
    const s = await store.create({})
    const id = s.id
    const legacy =
      `%meta {id: '${id}', title: 'Roxie', profile: 'rp', sessionMeta: {persona: {user: 'Макс'}, lorebook: {entries: [{keys: ['a'], content: '${'x'.repeat(400)}'}]}}, ` +
      `personas: [{id: 'roxie', kind: 'char', name: 'Roxie', card: {name: 'Roxie', description: 'line1\\nline2'}}], userId: 'roxie', botName: 'Roxie'}\n` +
      `%assistant {id: 'a1'}\nпривет\n`
    writeFileSync(join(dir, `${id}.mds`), legacy)
    const personas = await store.personas!.get(id)
    expect(personas.personas[0]).toMatchObject({ id: 'roxie', card: { description: 'line1\nline2' } })
    expect((await store.meta!.get(id)).persona).toEqual({ user: 'Макс' })
    expect(humanReadableViolations(fileOf(dir, id)).length).toBeGreaterThan(0)

    await store.meta!.patch(id, { depthPrompt: { text: 'n', depth: 2 } })
    const text = fileOf(dir, id)
    expect(humanReadableViolations(text)).toEqual([])
    expect(text).toMatch(/^%%character roxie /m)
    expect(text).toMatch(/^%%lorebook \{format: 'json5'\}$/m)
    expect(await store.personas!.get(id)).toEqual(personas)
    expect((await store.meta!.get(id)).lorebook).toMatchObject({ entries: [{ keys: ['a'] }] })
    expect((await store.load(id)).nodes.map((n) => n.parts)).toEqual([[{ type: 'text', text: 'привет' }]])
  })

  it('длинная строка меты — подузлом без формата, текст как есть', async () => {
    const { dir, store } = fresh()
    const s = await store.create({})
    const note = 'Первая строка.\n\n%user не маркер\nпоследняя'
    await store.meta!.patch(s.id, { note })
    const text = fileOf(dir, s.id)
    expect(text).toMatch(/^%%note$/m)
    expect(humanReadableViolations(text)).toEqual([])
    expect((await store.meta!.get(s.id)).note).toBe(note)
    // снять ключ — снимается и подузел
    await store.meta!.set!(s.id, {})
    expect(fileOf(dir, s.id)).not.toMatch(/%%note/)
  })

  it('forkCopy переносит подузлы шапки, аватар — на sidecar форка', async () => {
    const { dir, store } = fresh(fakeCodec)
    const s = await store.create({})
    const av = await store.assets!.put(s.id, 'r.png', new Uint8Array([1]))
    await store.appendNode(s.id, { role: 'assistant', text: 'g' })
    await store.personas!.set(s.id, { ...PERSONAS, personas: [{ ...PERSONAS.personas[0], avatar: av.ref }, PERSONAS.personas[1]] })
    const fork = await store.forkCopy!(s.id)
    const text = fileOf(dir, fork.id)
    expect(humanReadableViolations(text)).toEqual([])
    expect(text).toMatch(new RegExp(`^%%character roxie \\{.*avatar: 'file:${fork.id}\\.assets/r\\.png', format: 'kv'\\}$`, 'm'))
    expect((await store.personas!.get(fork.id)).personas[0].card).toEqual(CARD)
  })
})

describe('0a: writer nr-chat — файл читается глазами на любом пути записи', () => {
  it('create, ход с рецептом, персоны с картой, inline-профиль, мета, компакция, правка, свайп, форк, rename', async () => {
    const { dir, store } = fresh(fakeCodec)
    const s = await store.create({ info: { title: 'Длинное название сессии' } })
    const g = await store.appendNode(s.id, { role: 'assistant', text: 'гритинг\nв две строки', meta: { greeting: 0 } })
    const ids: string[] = [g.id]
    for (let i = 0; i < 30; i++) {
      const u = await store.appendNode(s.id, { role: 'user', text: `ход ${i}` })
      const a = await store.appendNode(s.id, { role: 'assistant', text: `ответ ${i}\n\n*действие*`, meta: { personaId: 'roxie' } })
      ids.push(u.id, a.id)
      await store.recipes!.put(s.id, { forMessageId: a.id, at: new Date().toISOString(), systemHash: 'abc', messageIds: [...ids], messageHashes: ids.map(() => 'deadbeef'), injections: [{ role: 'user', hash: 'def', source: 'lorebook:bot: Очень длинное имя записи лорбука' }], tools: ['read', 'write', 'skill', 'artifact_init'] } as never, new Map([['abc', 'S'], ['def', 'P']]))
    }
    await store.personas!.set(s.id, PERSONAS)
    await store.choices!.set(s.id, { model: { provider: 'lgate', model: 'mac/heretic', thinking: 'off' }, profile: 'inline', profileDoc: { id: 'x', name: 'RP', systemPrompt: 'Ты — рассказчик.\nПиши от третьего лица.' } as never })
    await store.meta!.patch(s.id, { persona: { user: 'Макс' }, prompt: { pre: 'свой\nпромпт', post: 'хвост' }, lorebook: { entries: [{ keys: ['Rico'], content: 'Rico — бармен.\nМолчалив.' }] }, depthPrompt: { text: 'note', depth: 4 } })
    await store.compaction!.append(s.id, { summary: 'Сводка\nдвух абзацев', firstKeptEntryId: ids[10], tokensBefore: 12000 } as never)
    await store.editNode(s.id, ids[2], { text: 'правка\nответа' } as never)
    await store.appendNode(s.id, { role: 'assistant', text: 'свайп', parent: ids[ids.length - 2] })
    await store.rename!(s.id, 'Новое название')
    const fork = await store.forkCopy!(s.id, ids[20])

    for (const id of [s.id, fork.id]) expect(humanReadableViolations(fileOf(dir, id))).toEqual([])
  })
})
