/**
 * assembly: лорбук (перенос из pi-ext-session-meta, DEV-222) и RP-куски сборки —
 * story string, вставка на глубине, impersonate-шаблон. Полная сюита отбора
 * живёт и в pi-ext (он реэкспортирует отсюда); здесь — ядро правил и
 * доработки dsh-donor §10 (глубина, приоритет, причины).
 */

import { describe, it, expect } from 'vitest'
import {
  DEFAULT_IMPERSONATE_TEMPLATE,
  estimateTokens,
  impersonatePrompt,
  injectAtDepth,
  joinStart,
  lorebookOf,
  selectLore,
  storyString,
  stripName,
  type Lorebook,
} from '../src/assembly/index.js'

const entry = (over: Record<string, unknown>) => ({ keys: [], content: 'x', enabled: true, insertion_order: 0, extensions: {}, ...over })

describe('лорбук: правила отбора (как в pi-ext)', () => {
  it('constant, ключ подстрокой, слово целиком — только явно; регистр', () => {
    const book: Lorebook = {
      entries: [
        entry({ name: 'C', constant: true }),
        entry({ name: 'Sub', keys: ['академи'] }),
        entry({ name: 'Whole', keys: ['кот'], extensions: { match_whole_words: true } }),
        entry({ name: 'Case', keys: ['Rico'], case_sensitive: true }),
      ],
    }
    const s = selectLore([{ kind: 'bot', book }], ['В академии котёнок. rico'])
    expect(s.before.map((e) => e.name)).toEqual(['C', 'Sub'])
    expect(s.before.map((e) => e.reason)).toEqual(['constant', 'ключ «академи»'])
    expect(s.depth).toEqual([])
  })

  it('selective: AND по вторичным; скан карточки — причина «карточка»', () => {
    const book: Lorebook = { entries: [entry({ name: 'Sel', keys: ['башн'], selective: true, secondary_keys: ['маг'] }), entry({ name: 'Card', keys: ['Scarlett'] })] }
    const noCard = selectLore([{ kind: 'bot', book }], ['Башня стоит'])
    expect(noCard.before).toEqual([])
    const card = selectLore([{ kind: 'bot', book }], ['Башня стоит, маг рядом'], { scanCard: true, cardText: 'Scarlett — наёмница' })
    expect(card.before.map((e) => [e.name, e.reason])).toEqual([
      ['Sel', 'ключ «башн» + «маг»'],
      ['Card', 'карточка: ключ «Scarlett»'],
    ])
  })

  it('общий бюджет: не влезла — отброшена с причиной, следующие пробуют; порядок источников', () => {
    const big = 'я'.repeat(300)
    const bot: Lorebook = { entries: [entry({ name: 'Big', constant: true, content: big, insertion_order: 1 }), entry({ name: 'Small', constant: true, content: 'ok', insertion_order: 2 })] }
    const persona: Lorebook = { entries: [entry({ name: 'P', constant: true, insertion_order: 1 })] }
    const s = selectLore([{ kind: 'persona', book: persona }, { kind: 'bot', book: bot }], [], { budget: 20 })
    // insertion_order 1: bot → persona (равный порядок — бот первым), Big не влез.
    expect(s.dropped).toEqual(['lorebook:bot: Big'])
    expect(s.droppedEntries).toEqual([{ label: 'lorebook:bot: Big', name: 'Big', source: 'bot', tokens: estimateTokens(big), reason: 'бюджет' }])
    expect(s.before.map((e) => `${e.source}:${e.name}`)).toEqual(['persona:P', 'bot:Small'])
  })

  it('ST world info → книга: глубинная позиция сохраняется в расширениях', () => {
    const book = lorebookOf({ entries: { 0: { key: ['x'], content: 'deep', position: 4, depth: 2, role: 1, comment: 'D', order: 5, priority: 7 } } })!
    const e = (book.entries as Array<Record<string, unknown>>)[0]!
    expect(e.position).toBe('before_char')
    expect(e.extensions).toMatchObject({ position: 4, depth: 2, role: 1 })
    expect(e.priority).toBe(7)
  })
})

describe('лорбук: доработки dsh-donor §10 (только с опциями)', () => {
  const deep = entry({ name: 'Deep', constant: true, content: 'на глубине', extensions: { position: 4, depth: 2, role: 1 } })

  it('без depthPositions — запись «на глубине» до карточки (поведение pi)', () => {
    const s = selectLore([{ kind: 'bot', book: { entries: [deep] } }], [])
    expect(s.before.map((e) => e.name)).toEqual(['Deep'])
    expect(s.depth).toEqual([])
  })

  it('depthPositions — в depth с глубиной и ролью', () => {
    const s = selectLore([{ kind: 'bot', book: { entries: [deep, entry({ name: 'At', constant: true, position: 'at_depth', depth: 0 })] } }], [], { depthPositions: true })
    expect(s.before).toEqual([])
    expect(s.depth.map((e) => [e.name, e.position, e.depth, e.role])).toEqual([
      ['Deep', 'at_depth', 2, 'user'],
      ['At', 'at_depth', 0, 'system'],
    ])
  })

  it('priority — при нехватке бюджета первой уходит младшая; порядок промпта — insertion_order', () => {
    const t = 'слово '.repeat(10)
    const book: Lorebook = {
      entries: [
        entry({ name: 'Low', constant: true, content: t, insertion_order: 1, priority: 1 }),
        entry({ name: 'High', constant: true, content: t, insertion_order: 2, priority: 10 }),
      ],
    }
    const budget = estimateTokens(t.trim()) + 1
    expect(selectLore([{ kind: 'bot', book }], [], { budget }).before.map((e) => e.name)).toEqual(['Low'])
    const p = selectLore([{ kind: 'bot', book }], [], { budget, priority: true })
    expect(p.before.map((e) => e.name)).toEqual(['High'])
    expect(p.dropped).toEqual(['lorebook:bot: Low'])
  })
})

describe('story string и глубина', () => {
  const lore = (text: string, name: string) => ({ source: `lorebook:bot: ${name}`, text })

  it('лор до · pre · лор после · персона · штатный (append)', () => {
    const r = storyString({ before: [lore('B', 'b')], pre: 'PRE', after: [lore('A', 'a')], persona: "Me's Persona: x" }, [{ source: 'profile', text: 'BASE' }])
    expect(r.system).toBe("B\n\nPRE\n\nA\n\nMe's Persona: x\n\nBASE")
    expect(r.blocks.map((b) => b.source)).toEqual(['lorebook:bot: b', 'meta.pre', 'lorebook:bot: a', 'persona.user', 'profile'])
  })

  it('replace с pre — без штатного; replace без pre — штатный остаётся; пустое выпадает', () => {
    expect(storyString({ pre: 'PRE' }, [{ source: 'profile', text: 'BASE' }], 'replace').system).toBe('PRE')
    expect(storyString({ before: [lore('B', 'b')] }, [{ source: 'profile', text: 'BASE' }], 'replace').system).toBe('B\n\nBASE')
    expect(storyString({ pre: 'PRE', persona: '' }, [{ source: 'profile', text: '' }]).system).toBe('PRE')
    expect(storyString({}, [{ source: 'profile', text: 'BASE' }]).system).toBe('BASE')
  })

  it('injectAtDepth: 0 — в конец, больше длины — в начало, несколько — от конца исходной', () => {
    expect(injectAtDepth(['a', 'b', 'c'], [{ depth: 0, message: 'N' }])).toEqual(['a', 'b', 'c', 'N'])
    expect(injectAtDepth(['a', 'b', 'c'], [{ depth: 1, message: 'N' }])).toEqual(['a', 'b', 'N', 'c'])
    expect(injectAtDepth(['a'], [{ depth: 9, message: 'N' }])).toEqual(['N', 'a'])
    expect(injectAtDepth(['a', 'b'], [{ depth: 1, message: 'X' }, { depth: 0, message: 'Y' }, { depth: 1, message: 'Z' }])).toEqual(['a', 'X', 'Z', 'b', 'Y'])
  })
})

describe('impersonate: шаблон и макросы (как плагин rp)', () => {
  const persona = { scenario: 'тайно служит {{char}}', system_prompt: 'SYS', post_history_instructions: 'POST', description: 'desc' }

  it('дефолт: persona_system → шаблон (scenario, input) → persona_post', () => {
    const p = impersonatePrompt(undefined, { user: 'Ann', char: 'Bob', input: 'спроси имя', persona })
    expect(p).toBe("SYS\n\nWrite Ann's next reply in first person, in Ann's voice; do not write for Bob.\nтайно служит Bob\nспроси имя\n\nPOST")
  })

  it('пустой известный макрос выбрасывает строку; шаблон сам ставит persona_system', () => {
    const p = impersonatePrompt('Top {{persona_system}}\nScenario: {{scenario}}\n{{input}}\n{{unknown}}', { user: 'A', char: 'B', input: '', persona: { system_prompt: 'S' } })
    expect(p).toBe('Top S\n{{unknown}}')
    expect(DEFAULT_IMPERSONATE_TEMPLATE).toContain('{{input}}')
  })

  it('joinStart/stripName', () => {
    expect(joinStart('Привет', 'Привет, как дела')).toBe('Привет, как дела')
    expect(joinStart('Я', 'иду')).toBe('Я иду')
    expect(stripName('Ann: hi', 'Ann')).toBe('hi')
  })
})
