/**
 * Лорбук (RP-1b/1c): отбор записей — чистые функции. Перенесены из
 * pi-ext-session-meta (DEV-224): отбор живёт здесь, расширение — адаптер.
 * Плюс `lore-files`: атрибуты `$lorebook*` → книги с диска.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SCAN_DEPTH, DEFAULT_TOKEN_BUDGET, entryName, estimateTokens, keyMatches, lorebookOf, selectLore, selectLorebook, type Lorebook } from '../src/assembly/index.js'
import { loadProfileLore, profileLoreConfig } from '../src/lore-files.js'

const entry = (over: Record<string, unknown>) => ({ keys: [], content: 'x', enabled: true, insertion_order: 0, extensions: {}, ...over })
const names = (book: Lorebook, messages: string[]) => {
  const s = selectLorebook(book, messages)
  return { before: s.before.map((e) => e.name), after: s.after.map((e) => e.name) }
}

describe('selectLorebook', () => {
  it('constant — всегда, выключенная — никогда', () => {
    const book = { entries: [entry({ name: 'C', constant: true }), entry({ name: 'Off', constant: true, enabled: false })] }
    expect(names(book, [])).toEqual({ before: ['C'], after: [] })
  })

  it('keys: подстрокой по умолчанию (ключи-основы), регистр не важен', () => {
    const book = { entries: [entry({ name: 'Rico', keys: ['Rico', 'Мясник'] }), entry({ name: 'Ann', keys: ['ann'] }), entry({ name: 'Acad', keys: ['академи'] })] }
    expect(names(book, ['вчера rico заходил']).before).toEqual(['Rico'])
    expect(names(book, ['Это МЯСНИК.']).before).toEqual(['Rico'])
    expect(names(book, ['Мясника видели']).before).toEqual(['Rico'])
    expect(names(book, ['Annabel пришла']).before).toEqual(['Ann'])
    expect(names(book, ['учится в академии']).before).toEqual(['Acad'])
    expect(names(book, ['никого']).before).toEqual([])
  })

  it('слово целиком — только явным match_whole_words: true (запись или книга)', () => {
    const rec = { entries: [entry({ name: 'W', keys: ['Мясник'], extensions: { match_whole_words: true } })] }
    expect(names(rec, ['Мясника видели']).before).toEqual([])
    expect(names(rec, ['Это мясник.']).before).toEqual(['W'])
    const book = { extensions: { match_whole_words: true }, entries: [entry({ name: 'B', keys: ['ann'] }), entry({ name: 'S', keys: ['ann'], extensions: { match_whole_words: false } })] }
    expect(names(book, ['Annabel']).before).toEqual(['S'])
    expect(names(book, ['Ann']).before).toEqual(['B', 'S'])
  })

  it('case_sensitive и match_whole_words: false', () => {
    const book = {
      entries: [entry({ name: 'CS', keys: ['Rico'], case_sensitive: true }), entry({ name: 'Stem', keys: ['академи'], extensions: { match_whole_words: false } })],
    }
    expect(names(book, ['rico']).before).toEqual([])
    expect(names(book, ['Rico']).before).toEqual(['CS'])
    expect(names(book, ['в академии']).before).toEqual(['Stem'])
  })

  it('selective: primary И хоть один secondary', () => {
    const book = { entries: [entry({ name: 'Sel', keys: ['меч'], secondary_keys: ['огонь', 'лёд'], selective: true })] }
    expect(names(book, ['меч']).before).toEqual([])
    expect(names(book, ['огонь']).before).toEqual([])
    expect(names(book, ['меч и лёд']).before).toEqual(['Sel'])
    // Без selective secondary не нужен.
    const loose = { entries: [entry({ name: 'L', keys: ['меч'], secondary_keys: ['огонь'] })] }
    expect(names(loose, ['меч']).before).toEqual(['L'])
  })

  it('scan_depth: дефолт 4, книга задаёт свою', () => {
    const history = ['дракон', 'a', 'b', 'c', 'd']
    const book = { entries: [entry({ name: 'D', keys: ['дракон'] })] }
    expect(DEFAULT_SCAN_DEPTH).toBe(4)
    expect(names(book, history).before).toEqual([]) // дракон — пятый с конца
    expect(names({ ...book, scan_depth: 5 }, history).before).toEqual(['D'])
    expect(names(book, history.slice(1).concat('дракон')).before).toEqual(['D'])
  })

  it('порядок insertion_order, позиции до/после карточки', () => {
    const book = {
      entries: [
        entry({ name: 'B2', constant: true, insertion_order: 20 }),
        entry({ name: 'A1', constant: true, insertion_order: 5, position: 'after_char' }),
        entry({ name: 'B1', constant: true, insertion_order: 10, position: '' }),
        entry({ name: 'A2', constant: true, insertion_order: 30, position: 1 }),
      ],
    }
    expect(names(book, [])).toEqual({ before: ['B1', 'B2'], after: ['A1', 'A2'] })
  })

  it('бюджет: не влезающая запись отбрасывается, следующие пробуют (дефолт 16000)', () => {
    const big = 'x'.repeat(3000)
    const small = 'мелочь'
    const t = estimateTokens(big)
    const book = {
      token_budget: t + estimateTokens(small),
      entries: [
        entry({ name: 'Big', constant: true, insertion_order: 1, content: big }),
        entry({ name: 'Big2', constant: true, insertion_order: 2, content: big }),
        entry({ name: 'Small', constant: true, insertion_order: 3, content: small }),
      ],
    }
    expect(names(book, []).before).toEqual(['Big', 'Small'])
    expect(selectLorebook(book, []).dropped).toEqual(['lorebook:bot: Big2'])
    // Дефолт 16000: запись больше бюджета не входит вовсе, 1024 из 179 — уже входит.
    expect(DEFAULT_TOKEN_BUDGET).toBe(16000)
    const mid = { entries: [entry({ name: 'M', constant: true, content: 'x'.repeat(10000) })] }
    expect(names(mid, []).before).toEqual(['M'])
    const huge = { entries: [entry({ name: 'H', constant: true, content: 'x'.repeat(100000) })] }
    expect(names(huge, []).before).toEqual([])
  })

  it('имя записи: name → comment → первый ключ → #индекс; {{user}} раскрывается', () => {
    expect(entryName({ name: '', comment: 'Комм', keys: ['k'] }, 0)).toBe('Комм')
    expect(entryName({ keys: ['k'] }, 0)).toBe('k')
    expect(entryName({}, 3)).toBe('#3')
    const s = selectLorebook({ entries: [entry({ constant: true, content: '{{user}} здесь' })] }, [], (t) => t.replace('{{user}}', 'Вилл'))
    expect(s.before[0]?.content).toBe('Вилл здесь')
  })

  it('keyMatches: ключ с не-буквой на краю', () => {
    expect(keyMatches('тег #rp тут', '#rp', { caseSensitive: false, wholeWord: true })).toBe(true)
  })
})

describe('selectLore: несколько источников', () => {
  const bot = { entries: [entry({ name: 'BotE', keys: ['дракон'], insertion_order: 10 }), entry({ name: 'BotTie', constant: true, insertion_order: 5 })] }
  const persona = { entries: [entry({ name: 'PerE', keys: ['меч'], insertion_order: 1 }), entry({ name: 'PerTie', constant: true, insertion_order: 5 })] }
  const profile = { entries: [entry({ name: 'ProfE', keys: ['цундэрэ'], insertion_order: 20 }), entry({ name: 'ProfTie', constant: true, insertion_order: 5 })] }
  const all = [
    { kind: 'profile' as const, book: profile },
    { kind: 'bot' as const, book: bot },
    { kind: 'persona' as const, book: persona },
  ]

  it('записи всех трёх — в один пул; порядок insertion_order, при равенстве бот → персона → профиль', () => {
    const s = selectLore(all, ['дракон и меч'], { scanCard: true, cardText: 'Она — цундэрэ.' })
    expect(s.before.map((e) => `${e.source}:${e.name}`)).toEqual(['persona:PerE', 'bot:BotTie', 'persona:PerTie', 'profile:ProfTie', 'bot:BotE', 'profile:ProfE'])
  })

  it('скан карточки: совпадение в карточке — активна на каждом ходу; без флага — нет', () => {
    expect(selectLore(all, ['привет'], { cardText: 'Она — цундэрэ.' }).before.map((e) => e.name)).not.toContain('ProfE')
    expect(selectLore(all, ['привет'], { scanCard: true, cardText: 'Она — цундэрэ.' }).before.map((e) => e.name)).toContain('ProfE')
    // Флаг книги extensions.scan_card — только у этой книги.
    const own = [{ kind: 'profile' as const, book: { ...profile, extensions: { scan_card: true } } }, { kind: 'bot' as const, book: { entries: [entry({ name: 'X', keys: ['цундэрэ'] })] } }]
    expect(selectLore(own, ['привет'], { cardText: 'цундэрэ' }).before.map((e) => e.name)).toEqual(['ProfTie', 'ProfE'])
  })

  it('общий бюджет: явный → максимум книг → 16000; перебор — dropped с источником', () => {
    const t = (n: number) => 'x'.repeat(n * 4)
    const a = { token_budget: 10, entries: [entry({ name: 'A', constant: true, content: t(8), insertion_order: 1 })] }
    const b = { token_budget: 30, entries: [entry({ name: 'B', constant: true, content: t(20), insertion_order: 2 })] }
    const c = { entries: [entry({ name: 'C', constant: true, content: t(5), insertion_order: 3 })] }
    const src = [{ kind: 'bot' as const, book: a }, { kind: 'persona' as const, book: b }, { kind: 'profile' as const, book: c }]
    const s = selectLore(src, [])
    expect(s.budget).toBe(30)
    expect(s.before.map((e) => e.name)).toEqual(['A', 'B'])
    expect(s.dropped).toEqual(['lorebook:profile: C'])
    // Явный бюджет профиля сильнее книг.
    expect(selectLore(src, [], { budget: 1000 }).dropped).toEqual([])
    expect(selectLore([{ kind: 'bot', book: c }], []).budget).toBe(16000)
  })

  it('lorebookOf: CCv3, карточка целиком, ST world info', () => {
    expect(lorebookOf({ entries: [] })).toEqual({ entries: [] })
    expect(lorebookOf({ spec: 'chara_card_v3', data: { character_book: { entries: [entry({ name: 'In' })] } } })?.entries).toHaveLength(1)
    const wi = lorebookOf({
      entries: {
        '0': { uid: 0, key: ['башн'], keysecondary: [], content: 'Башня мага.', comment: 'Tower', order: 7, position: 1, disable: false, constant: false, selective: true },
        '1': { uid: 1, key: ['x'], content: 'off', comment: 'Off', disable: true },
        '2': { uid: 2, key: ['Ann'], content: 'Энн.', comment: 'Ann', matchWholeWords: true },
      },
    })!
    const s = selectLore([{ kind: 'profile', book: wi }], ['у башни, Annabel x'])
    expect(s.after.map((e) => e.name)).toEqual(['Tower'])
    expect(s.before).toEqual([])
    expect(lorebookOf('нет')).toBeUndefined()
    expect(lorebookOf({ foo: 1 })).toBeUndefined()
  })

})

describe('lore-files', () => {
  it('profileLoreConfig: пути JSON-массивом, списком, массивом; бюджет; флаг — из поля или extra', () => {
    expect(profileLoreConfig({})).toEqual({ paths: [], scanCard: false })
    expect(profileLoreConfig({ lorebook: '["/a.json","/b.json"]', lorebook_budget: '16000', lorebook_scan_card: true })).toEqual({ paths: ['/a.json', '/b.json'], budget: 16000, scanCard: true })
    expect(profileLoreConfig({ extra: { lorebook: '$[a.json, b.json]', lorebook_scan_card: 'true' } })).toEqual({ paths: ['a.json', 'b.json'], scanCard: true })
    expect(profileLoreConfig({ lorebook: '/one.json' }).paths).toEqual(['/one.json'])
  })

  it('loadProfileLore: относительные — от base, битый файл — предупреждение, ран без него', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lore-files-'))
    writeFileSync(join(dir, 'w.json'), JSON.stringify({ entries: { 0: { key: ['x'], content: 'X' } } }))
    writeFileSync(join(dir, 'bad.json'), '{нет')
    const warns: string[] = []
    const lore = loadProfileLore({ extra: { lorebook: 'w.json, bad.json, none.json', lorebook_budget: '300' } }, dir, (m) => warns.push(m))
    expect(lore.books).toHaveLength(1)
    expect(lore.budget).toBe(300)
    expect(warns).toHaveLength(2)
  })
})
