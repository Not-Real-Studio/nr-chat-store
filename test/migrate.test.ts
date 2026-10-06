/**
 * `./migrate` (DEV-237, nr-driver-switch-spec §1, §3): pi → nr-chat с
 * fidelity и стор «nr-chat + старые pi только чтением».
 */

import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNrChatStore } from '../src/nr-chat/index.js'
import { createPiStore } from '../src/pi/index.js'
import { LEGACY_FORMAT_KEY, migrateSession, verifyMigration, withLegacySessions } from '../src/migrate.js'

/** Снимок каталога (рекурсивно): путь → base64 байтов. */
function snapshot(dir: string, base = ''): Array<[string, string]> {
  return readdirSync(join(dir, base))
    .sort()
    .flatMap((n): Array<[string, string]> => {
      const rel = join(base, n)
      return statSync(join(dir, rel)).isDirectory() ? snapshot(dir, rel) : [[rel, readFileSync(join(dir, rel)).toString('base64')]]
    })
}

function stores() {
  const piDir = mkdtempSync(join(tmpdir(), 'mig-pi-'))
  const nrDir = mkdtempSync(join(tmpdir(), 'mig-nr-'))
  return { piDir, nrDir, pi: createPiStore({ dir: piDir, piServiceEntries: 'hide' }), nr: createNrChatStore({ dir: nrDir }) }
}

/** pi-сессия как у стенда: аватар-вложение, персоны, мета, гритинги-свайпы, ответ с рецептом, компакция. */
async function piSession(pi: ReturnType<typeof createPiStore>) {
  const s = await pi.create()
  await pi.rename!(s.id, 'Roxie')
  await pi.choices!.set(s.id, { model: { provider: 'nr', model: 'mac/heretic' }, profile: 'rp' })
  await pi.meta!.set!(s.id, { persona: { user: 'Макс' }, prompt: { pre: 'GM' } })
  const avatar = await pi.assets!.put(s.id, 'roxie.png', new Uint8Array([137, 80, 78, 71]), 'image/png')
  const av = await pi.appendNode(s.id, { role: 'user', parts: [{ type: 'image', meta: { ref: avatar.ref, mime: 'image/png', role: 'avatar' } } as never] })
  await pi.hideNode!(s.id, av.id, true)
  await pi.personas!.set(s.id, { personas: [{ id: 'roxie', kind: 'char', name: 'Roxie', avatar: avatar.ref }, { id: 'max', kind: 'user', name: 'Макс' }], userId: 'max' })
  const g0 = await pi.appendNode(s.id, { role: 'assistant', text: 'g0', meta: { greeting: 0 } })
  const g1 = await pi.appendNode(s.id, { role: 'assistant', text: 'g1', parent: g0.parent, meta: { greeting: 1 } })
  await pi.setActiveLeaf!(s.id, g0.id)
  const u = await pi.appendNode(s.id, { role: 'user', text: 'привет', meta: { personaId: 'max' } })
  const a = await pi.appendNode(s.id, { role: 'assistant', text: 'ответ', meta: { personaId: 'roxie' } })
  await pi.recipes!.put(s.id, { forMessageId: a.id, systemHash: 'aa11', messageIds: [g0.id, u.id] }, new Map([['aa11', 'SYSTEM']]))
  await pi.compaction!.append(s.id, { summary: 'сжато', firstKeptEntryId: u.id, tokensBefore: 10 })
  const tail = await pi.appendNode(s.id, { role: 'user', text: 'после компакции' })
  return { sid: s.id, g0, g1, u, a, tail, avatar }
}

describe('migrateSession pi → nr-chat', () => {
  it('fidelity: история и лист, ветки, мета, персоны (аватар копией), выбор, рецепт с текстами', async () => {
    const { pi, nr, nrDir, piDir } = stores()
    const x = await piSession(pi)
    const before = snapshot(piDir)

    const report = await migrateSession(pi, nr, x.sid)
    expect(report.recipes).toBe(1)
    expect(Object.keys(report.assets)).toEqual([x.avatar.ref])
    expect(await verifyMigration(pi, nr, x.sid, report.assets)).toEqual([])

    const model = await nr.load(x.sid)
    expect(model.info.title).toBe('Roxie')
    expect(model.info.botName).toBe('Roxie')
    // Свайп гритинга — сиблинг с той же метой.
    const g1 = model.nodes.find((n) => n.id === x.g1.id)!
    expect(g1.meta).toMatchObject({ greeting: 1 })
    expect(g1.parent).toBe(model.nodes.find((n) => n.id === x.g0.id)!.parent)
    expect(await nr.meta!.get(x.sid)).toEqual({ persona: { user: 'Макс' }, prompt: { pre: 'GM' } })
    const personas = await nr.personas!.get(x.sid)
    expect(personas.userId).toBe('max')
    const ref = (personas.personas[0] as { avatar: string }).avatar
    expect(ref).toBe(`file:${x.sid}.assets/${x.avatar.ref}`)
    expect([...(await nr.assets!.get!(x.sid, ref)).data]).toEqual([137, 80, 78, 71])
    expect(await nr.choices!.get(x.sid)).toEqual({ model: { provider: 'nr', model: 'mac/heretic' }, profile: 'rp' })
    const recipe = await nr.recipes!.get(x.sid, x.a.id)
    expect(recipe?.data).toMatchObject({ systemHash: 'aa11', messageIds: [x.g0.id, x.u.id] })
    expect(recipe?.texts.get('aa11')).toBe('SYSTEM')
    // Исходник не тронут.
    expect(snapshot(piDir)).toEqual(before)
    // Файл nr-chat — без служебных pi-полей.
    expect(readFileSync(join(nrDir, `${x.sid}.mds`), 'utf-8')).not.toMatch(/nrs[A-Z]|customType/)
  })

  it('сессия в приёмнике есть — ошибка; overwrite — перенос заново', async () => {
    const { pi, nr } = stores()
    const x = await piSession(pi)
    await migrateSession(pi, nr, x.sid)
    await expect(migrateSession(pi, nr, x.sid)).rejects.toThrow(/уже есть/)
    const r = await migrateSession(pi, nr, x.sid, { overwrite: true })
    expect(await verifyMigration(pi, nr, x.sid, r.assets)).toEqual([])
  })
})

describe('withLegacySessions: nr-chat + старые pi только чтением', () => {
  it('список — объединение; старая читается с legacyFormat; запись → перенос, старый файл не меняется', async () => {
    const { pi, nr, piDir, nrDir } = stores()
    const x = await piSession(pi)
    const store = withLegacySessions(nr, pi)
    const fresh = await store.create({ info: { title: 'новая' } })
    expect((await store.list()).sessions.map((s) => s.id).sort()).toEqual([fresh.id, x.sid].sort())

    expect((await store.meta!.get(x.sid))[LEGACY_FORMAT_KEY]).toBe('pi/2')
    expect((await store.load(x.sid)).nodes.length).toBeGreaterThan(0)
    expect(readdirSync(nrDir).filter((n) => n.startsWith(x.sid))).toEqual([])

    const piBefore = snapshot(piDir)
    await store.appendNode(x.sid, { role: 'assistant', text: 'новая реплика' })
    expect(readdirSync(nrDir)).toContain(`${x.sid}.mds`)
    expect(snapshot(piDir)).toEqual(piBefore)
    expect((await store.meta!.get(x.sid))[LEGACY_FORMAT_KEY]).toBeUndefined()
    const hist = (await store.load(x.sid)).nodes
    expect(hist.at(-1)!.parts).toEqual([{ type: 'text', text: 'новая реплика' }])
    expect((await store.list()).sessions.filter((s) => s.id === x.sid)).toHaveLength(1)
  })

  it('«конвертировать» — патч {legacyFormat: null}: перенос без новых ключей меты', async () => {
    const { pi, nr } = stores()
    const x = await piSession(pi)
    const store = withLegacySessions(nr, pi)
    const doc = await store.meta!.get(x.sid)
    const { [LEGACY_FORMAT_KEY]: _l, ...rest } = doc
    await store.meta!.set!(x.sid, rest)
    expect(await nr.meta!.get(x.sid)).toEqual({ persona: { user: 'Макс' }, prompt: { pre: 'GM' } })
  })

  it('удаление старой — отказ; параллельные записи — один перенос', async () => {
    const { pi, nr } = stores()
    const x = await piSession(pi)
    const store = withLegacySessions(nr, pi)
    await expect(store.delete!(x.sid)).rejects.toThrow(/только чтение/)
    let migrated = 0
    const counted = withLegacySessions(nr, pi, { onMigrate: () => void migrated++ })
    await Promise.all([counted.rename!(x.sid, 'A'), counted.meta!.patch(x.sid, { k: 1 }), counted.personas!.set(x.sid, { personas: [] })])
    expect(migrated).toBe(1)
    expect((await nr.load(x.sid)).info.title).toBe('A')
  })
})
