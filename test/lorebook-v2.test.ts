/**
 * Лорбук v2 (DEV-446, lorebook-v2-spec §8): каждый случай — на обоих путях
 * сборки (`assembleRp` и шаблон `rp.mds` билдера); расхождение путей — красный.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Message, Persona } from '../src/model.js'
import { assembleRp, selectLore, textOf, type ProfileLore } from '../src/assembly/index.js'
import { calibratedThreshold, entryKey, loreBooks, selectLoreV2, type LoreEmbedScores, type LorePin, type LoreV2Selection } from '../src/assembly/lore-v2.js'
import { LORE_ONCE_META, LORE_PINS_META, LORE_WARNING_SOURCE } from '../src/assembly/lore-run.js'
import { buildMdsTemplate } from '../src/builder/index.js'

const RP = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'builder', 'rp.mds'), 'utf8')

const msg = (id: string, role: string, text: string, meta?: Record<string, unknown>): Message => ({ id, role, parts: [{ type: 'text', text }], ...(meta ? { meta } : {}) })
const me: Persona = { id: 'me', kind: 'user', name: 'Ann' }
const char = (book?: unknown, id = 'bot', name = 'Scarlett'): Persona => ({ id, kind: 'char', name, ...(book ? { card: { character_book: book } } : {}) }) as Persona

type Row = [string, string]
interface Both {
  rp: { system: string; msgs: Row[]; lore?: LoreV2Selection; injections: Array<{ role: string; source: string; text: string }> }
  tpl: { system: string; msgs: Row[]; injections: Array<{ role: string; source: string; text: string }> }
}

/** Сборка на обоих путях; лента — [роль, текст] (system v2 — отдельной ролью). */
async function both(o: { personas: Persona[]; meta?: Record<string, unknown>; path: Message[]; lore?: Partial<ProfileLore> }): Promise<Both> {
  const profileLore: ProfileLore = { books: [], scanCard: false, ...(o.lore ?? {}) }
  const meta = o.meta ?? {}
  const rp = assembleRp({ messages: o.path, meta, personas: { personas: o.personas, userId: 'me' }, base: [], profileLore, seed: 's' })
  const out = await buildMdsTemplate({
    session: { id: 's' },
    document: { path: o.path, meta, personas: o.personas, userId: 'me' },
    agent: { id: 'rp', name: 'RP', template: RP, includes: {}, templatePath: 'fixture:rp.mds' },
    model: { id: 'm' },
    base: [],
    tools: [],
    profileLore,
  })
  let lead = 0
  while (lead < out.nodes.length && out.nodes[lead]!.role === 'system' && !out.nodes[lead]!.history) lead++
  const tplMsgs: Row[] = out.nodes.slice(lead).map((n) => [n.injectSend === 'system' ? 'system' : n.history || n.role === 'assistant' ? n.role : 'user', textOf(n)])
  const rpMsgs: Row[] = rp.messages.map((m) => [m.role, textOf(m)])
  const res: Both = {
    rp: { system: rp.system, msgs: rpMsgs, ...(rp.lore2 ? { lore: rp.lore2 } : {}), injections: rp.injections.map((i) => ({ role: i.role, source: i.source, text: i.text })) },
    tpl: { system: out.recipe.systemBlocks.map((b) => b.text).join('\n\n'), msgs: tplMsgs, injections: out.recipe.injections.map((i) => ({ role: i.role, source: i.source, text: i.text })) },
  }
  // Паритет путей: лента и system — байт в байт; инъекции лорбука — те же.
  expect(res.tpl.msgs).toEqual(res.rp.msgs)
  expect(res.tpl.system).toBe(res.rp.system)
  const loreInj = (l: Both['rp']['injections']) => l.filter((i) => i.source.startsWith('lorebook'))
  expect(loreInj(res.tpl.injections)).toEqual(loreInj(res.rp.injections))
  return res
}

const book = (entries: unknown[], nr?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ name: 'B', entries, ...(nr ? { extensions: { nr } } : {}), ...extra })
const prefixOf = (rows: Row[], n: number) => JSON.stringify(rows.slice(0, n))

describe('лорбук v2 — подача', () => {
  it('1. prefix: две книги разных источников — system байт в байт на разных репликах', async () => {
    const botBook = book([{ keys: ['x'], content: 'Шея — чувствительная.', name: 'Neck' }])
    const sessionBook = { book: book([{ keys: ['y'], content: 'Мир — Ржавый город.', name: 'World' }], undefined, { name: 'S' }) }
    const personas = [char(botBook), me]
    const a = await both({ personas, meta: { lorebooks: [sessionBook] }, path: [msg('g', 'assistant', 'Привет.'), msg('u1', 'user', 'Привет!')] })
    const b = await both({ personas, meta: { lorebooks: [sessionBook] }, path: [msg('g', 'assistant', 'Привет.'), msg('u1', 'user', 'Совсем другое.')] })
    expect(a.rp.system).toBe(b.rp.system)
    expect(a.rp.system).toContain('Шея — чувствительная.')
    expect(a.rp.system).toContain('Мир — Ржавый город.')
    expect(a.rp.system.indexOf('Шея')).toBeLessThan(a.rp.system.indexOf('Мир')) // бот раньше сессии
  })

  it('2. sticky: закреплена на реплике 3 и стоит после неё дальше; префикс растёт; свайп — та же; правка — заново', async () => {
    const lore = book([{ id: 7, keys: ['Rico'], content: 'Rico — мясник.', name: 'Rico' }], { delivery: 'sticky' })
    const personas = [char(lore), me]
    const h3 = [msg('u1', 'user', 'Привет'), msg('a1', 'assistant', 'Хай'), msg('u2', 'user', 'Как дела'), msg('a2', 'assistant', 'Норм'), msg('u3', 'user', 'Кто такой Rico?')]
    const t3 = await both({ personas, path: h3 })
    expect(t3.rp.lore!.pins).toEqual([{ book: 'bot:bot', entry: '7' }])
    expect(t3.rp.lore!.anchor).toBe('u3')
    expect(t3.rp.msgs.at(-1)).toEqual(['system', 'Rico — мясник.'])
    // Хост пишет закрепление в мету реплики 3.
    const pinned = h3.map((m) => (m.id === 'u3' ? { ...m, meta: { [LORE_PINS_META]: t3.rp.lore!.pins } } : m))
    for (const n of [4, 5, 6]) {
      const tail: Message[] = []
      for (let k = 3; k < n; k++) tail.push(msg(`a${k}`, 'assistant', `Ответ ${k}`), msg(`u${k + 1}`, 'user', `Реплика ${k + 1}`))
      const t = await both({ personas, path: [...pinned, ...tail] })
      expect(t.rp.lore!.pins).toEqual([])
      expect(t.rp.msgs[5]).toEqual(['system', 'Rico — мясник.'])
      expect(prefixOf(t.rp.msgs, t3.rp.msgs.length)).toBe(JSON.stringify(t3.rp.msgs))
      expect(t.rp.system).toBe(t3.rp.system)
    }
    // Свайп ответа на ход 3 — закрепление в реплике, та же запись.
    const swipe = await both({ personas, path: [...pinned, msg('a3b', 'assistant', 'Другой ответ'), msg('u4', 'user', 'Дальше')] })
    expect(swipe.rp.msgs[5]).toEqual(['system', 'Rico — мясник.'])
    // Правка реплики 3 — новый узел без меты: выбор заново.
    const edited = await both({ personas, path: [...h3.slice(0, 4), msg('u3x', 'user', 'Кто такой Rico, а?')] })
    expect(edited.rp.lore!.pins).toEqual([{ book: 'bot:bot', entry: '7' }])
    expect(edited.rp.lore!.anchor).toBe('u3x')
  })

  it('3. once: в хвосте хода N, нет в N+1; всё до хвоста — байт в байт', async () => {
    const lore = book([{ keys: ['ше'], content: 'Шея: тонкая кожа.', name: 'Neck' }], { delivery: 'once' })
    const personas = [char(lore), me]
    const hN = [msg('a0', 'assistant', 'Сцена.'), msg('u1', 'user', 'Целую в шею')]
    const tN = await both({ personas, path: hN })
    expect(tN.rp.msgs.at(-1)).toEqual(['system', 'Шея: тонкая кожа.'])
    const tN1 = await both({ personas, path: [...hN, msg('a1', 'assistant', 'Она вздрагивает.'), msg('u2', 'user', 'Иду к окну')] })
    expect(tN1.rp.msgs.some(([, t]) => t.includes('тонкая кожа'))).toBe(false)
    expect(prefixOf(tN1.rp.msgs, 2)).toBe(prefixOf(tN.rp.msgs, 2))
    expect(tN1.rp.system).toBe(tN.rp.system)
  })

  it('14. порядок хвоста: реплика → once → post', async () => {
    const lore = book([{ keys: ['шея'], content: 'Шея.', name: 'Neck' }], { delivery: 'once' })
    const t = await both({ personas: [char(lore), me], meta: { prompt: { post: 'Пиши кратко.' } }, path: [msg('u1', 'user', 'Шея?')] })
    expect(t.rp.msgs).toEqual([
      ['user', 'Шея?'],
      ['system', 'Шея.'],
      ['user', 'Пиши кратко.'],
    ])
  })
})

describe('лорбук v2 — подбор', () => {
  const hist = [msg('u1', 'user', 'Привет'), msg('a1', 'assistant', 'Посмотри на башню.'), msg('u2', 'user', 'Ладно')]

  it('4. scan [1, 0.5]: совпало только с ответом бота — половина балла; [1] — не видит', async () => {
    const half = await both({ personas: [char(book([{ keys: ['башн'], content: 'Башня.', name: 'Tower' }], { delivery: 'once', scan: [1, 0.5] })), me], path: hist })
    expect(half.rp.lore!.once.map((e) => e.score)).toEqual([0.5])
    expect(half.rp.lore!.once[0]!.at).toBe(2)
    const one = await both({ personas: [char(book([{ keys: ['башн'], content: 'Башня.', name: 'Tower' }], { delivery: 'once', scan: [1] })), me], path: hist })
    expect(one.rp.lore!.once).toEqual([])
  })

  const embedOf = (book: string, entry: string, sims: Record<string, number>, threshold?: number): LoreEmbedScores => ({
    sims: new Map([[entryKey(book, entry), new Map(Object.entries(sims))]]),
    ...(threshold !== undefined ? { thresholds: new Map([[entryKey(book, entry), threshold]]) } : {}),
  })

  it('5. порог: ниже калиброванного — ноль записей; калибровка = максимум + 0.05', async () => {
    const lore = book([{ id: 1, keys: ['шея'], content: 'Шея.', name: 'Neck' }], { delivery: 'once', match: 'embed' })
    const low = await both({ personas: [char(lore), me], path: [msg('u1', 'user', 'Пошли есть мороженое')], lore: { embed: embedOf('bot:bot', '1', { u1: 0.31 }, 0.42) } })
    expect(low.rp.lore!.once).toEqual([])
    expect(low.rp.lore!.missed[0]!.reason).toMatch(/ниже порога/)
    const high = await both({ personas: [char(lore), me], path: [msg('u1', 'user', 'Провожу губами по горлу')], lore: { embed: embedOf('bot:bot', '1', { u1: 0.61 }, 0.42) } })
    expect(high.rp.lore!.once.map((e) => e.name)).toEqual(['Neck'])
    // Калибровка: косинусы записи с тремя фразами 0.2/0.3/0.1 → порог 0.35.
    const e = [1, 0, 0]
    const at = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0]
    expect(calibratedThreshold(e, [at(0.2), at(0.3), at(0.1)])).toBe(0.35)
  })

  it('6. both: имя без смыслового совпадения — срабатывает ключом', async () => {
    const lore = book([{ id: 1, keys: ['Rico'], content: 'Rico — мясник.', name: 'Rico' }], { delivery: 'once', match: 'both', threshold: 0.35 })
    const t = await both({ personas: [char(lore), me], path: [msg('u1', 'user', 'Rico здесь?')], lore: { embed: embedOf('bot:bot', '1', { u1: 0.1 }) } })
    expect(t.rp.lore!.once.map((e) => e.name)).toEqual(['Rico'])
    expect(t.rp.lore!.once[0]!.score).toBeCloseTo(0.4)
  })

  it('7. limit 2: не больше двух записей книги за ход', async () => {
    const entries = ['a', 'b', 'c', 'd'].map((k, i) => ({ keys: [k], content: `E${k}`, name: k, insertion_order: i }))
    const t = await both({ personas: [char(book(entries, { delivery: 'once', limit: 2 })), me], path: [msg('u1', 'user', 'a b c d')] })
    expect(t.rp.lore!.once).toHaveLength(2)
    expect(t.rp.lore!.missed.filter((m) => m.reason === 'лимит 2')).toHaveLength(2)
  })

  it('8. варианты: 3 варианта, 4 срабатывания — первые три разные, четвёртый — самый давний', async () => {
    const lore = book([{ id: 1, keys: ['шея'], content: 'Шея.', name: 'Neck', extensions: { nr: { variants: ['V1', 'V2', 'V3'] } } }], { delivery: 'once' })
    const personas = [char(lore), me]
    const path: Message[] = []
    const got: string[] = []
    for (let i = 1; i <= 4; i++) {
      path.push(msg(`u${i}`, 'user', `шея ${i}`))
      const t = await both({ personas, path: [...path] })
      got.push(t.rp.lore!.once[0]!.content)
      // Хост пишет вариант хода в мету реплики.
      path[path.length - 1] = { ...path[path.length - 1]!, meta: { [LORE_ONCE_META]: t.rp.lore!.oncePins } }
      path.push(msg(`a${i}`, 'assistant', `ответ ${i}`))
    }
    expect(got).toEqual(['V1', 'V2', 'V3', 'V1'])
  })

  it('9. группа: из двух сработавших одной группы — одна, при равных баллах та же на двух сборках', async () => {
    const lore = book(
      [
        { id: 1, keys: ['пьян'], content: 'Стадия: пьяна.', name: 'Drunk', extensions: { nr: { group: 'stage' } } },
        { id: 2, keys: ['пьян'], content: 'Стадия: трезва.', name: 'Sober', extensions: { nr: { group: 'stage' } } },
      ],
      { delivery: 'once' },
    )
    const personas = [char(lore), me]
    const a = await both({ personas, path: [msg('u1', 'user', 'Она пьяна?')] })
    const b = await both({ personas, path: [msg('u1', 'user', 'Она пьяна? Точно?')] })
    expect(a.rp.lore!.once).toHaveLength(1)
    expect(b.rp.lore!.once.map((e) => e.name)).toEqual(a.rp.lore!.once.map((e) => e.name))
    expect(a.rp.lore!.missed[0]!.reason).toBe('группа «stage»')
  })

  it('10. $lore_role: user — once текстом после реплики игрока; дефолт — system', async () => {
    const lore = book([{ keys: ['шея'], content: 'Шея.', name: 'Neck' }], { delivery: 'once' })
    const asUser = await both({ personas: [char(lore), me], path: [msg('u1', 'user', 'Шея?')], lore: { role: 'user' } })
    expect(asUser.rp.msgs).toEqual([['user', 'Шея?\n\n[lore: Neck]\nШея.']])
    const def = await both({ personas: [char(lore), me], path: [msg('u1', 'user', 'Шея?')] })
    expect(def.rp.msgs).toEqual([
      ['user', 'Шея?'],
      ['system', 'Шея.'],
    ])
  })

  it('12. гейт эмбедов недоступен — ключи работают, предупреждение в инъекциях', async () => {
    const lore = book(
      [
        { id: 1, keys: ['шея'], content: 'Шея.', name: 'Neck' },
        { id: 2, keys: ['zzz'], content: 'Бедро.', name: 'Hip', extensions: { nr: { match: 'embed' } } },
      ],
      { delivery: 'once', match: 'both', threshold: 0.3 },
    )
    const t = await both({ personas: [char(lore), me], path: [msg('u1', 'user', 'Шея?')], lore: { warnings: ['эмбеддер embed/giga недоступен — подбор ключами'] } })
    expect(t.rp.lore!.once.map((e) => e.name)).toEqual(['Neck'])
    expect(t.rp.injections.find((i) => i.source === LORE_WARNING_SOURCE)?.text).toMatch(/недоступен/)
  })
})

describe('лорбук v2 — дефолты, классика, миграция', () => {
  it('11. книга Chub без extensions.nr: маленькая — prefix, большая — once по ключам с scan_depth', async () => {
    const small = book([{ keys: ['x'], content: 'Маленькая.', name: 'S' }])
    const t = await both({ personas: [char(small), me], path: [msg('u1', 'user', 'нет ключа')] })
    expect(t.rp.lore!.prefix.map((e) => e.name)).toEqual(['S'])
    const huge = 'слово '.repeat(5000)
    const big = { ...book([{ keys: ['x'], content: huge, name: 'Huge' }, { keys: ['шея'], content: 'Шея.', name: 'Neck' }, { constant: true, content: 'Всегда.', name: 'C' }]), scan_depth: 4 }
    const b = await both({ personas: [char(big), me], path: [msg('u1', 'user', 'шея'), msg('a1', 'assistant', 'a'), msg('u2', 'user', 'b'), msg('a2', 'assistant', 'c')] })
    expect(b.rp.lore!.prefix.map((e) => e.name)).toEqual(['C'])
    expect(b.rp.lore!.once.map((e) => e.name)).toEqual(['Neck']) // на 4-й позиции — scan_depth 4 весами 1
  })

  it('11. classic — поведение selectLore прежнее', async () => {
    const lb = { entries: [{ keys: ['Rico'], content: 'Rico — мясник.', name: 'Butcher', insertion_order: 1 }, { constant: true, content: 'Всегда.', name: 'Const', insertion_order: 0 }, { keys: ['путник'], content: 'После.', name: 'After', position: 'after_char' }] }
    const path = [msg('g', 'assistant', 'Привет, путник.'), msg('u1', 'user', 'Что про Rico?')]
    const t = await both({ personas: [char(), me], meta: { lorebook: lb, prompt: { pre: 'PRE' } }, path, lore: { delivery: 'classic' } })
    const old = selectLore([{ kind: 'bot', book: lb }], ['Привет, путник.', 'Что про Rico?'], { depthPositions: true, priority: true })
    expect(t.rp.lore!.classic).toEqual(old)
    expect(t.rp.system).toBe('Всегда.\n\nRico — мясник.\n\nPRE\n\nПосле.')
  })

  it('13. миграция: meta.lorebook и character_book первой char — одна книга; второй бот — своей книгой', () => {
    const a = book([{ keys: ['a'], content: 'A' }])
    const c = book([{ keys: ['c'], content: 'C' }])
    const books = loreBooks({ metaLorebook: a, chars: [{ id: 'b1', card: { character_book: book([{ keys: ['a'], content: 'A-старая' }]) } }, { id: 'b2', card: { character_book: c } }] })
    expect(books.map((b) => [b.id, b.book])).toEqual([
      ['bot:b1', a],
      ['bot:b2', c],
    ])
  })

  it('дедуп: одна книга из двух источников — один раз', () => {
    const a = book([{ keys: ['a'], content: 'A' }])
    expect(loreBooks({ chars: [{ id: 'b1', card: { character_book: a } }], profile: [{ book: a, path: '/x.json' }] })).toHaveLength(1)
  })

  it('закрепление на книге, которую удалили, молча пропускается', () => {
    const pins: LorePin[] = [{ book: 'gone', entry: '1' }]
    const sel = selectLoreV2({ books: [], history: [{ id: 'u1', role: 'user', text: 'x', pins }] })
    expect(sel.sticky).toEqual([])
  })
})
