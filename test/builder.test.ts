/**
 * Билдер `mds-template` (session-document-spec §4, §8): фикстуры
 * `документ + агент → prompt.mds` — голый агент, RP-шаблон, include, префил,
 * пустые узлы, вставки на глубине, цепочка override `card`/`post`, макросы,
 * ошибки шаблона.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Message, Persona } from '../src/model.js'
import { buildMdsTemplate, defaultBuilders, resolveBuilder, templateIncludes, type BuildInput } from '../src/builder/index.js'
import { textOf } from '../src/assembly/index.js'

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'builder')
const AGENT = readFileSync(join(FIX, 'agent.mds'), 'utf8')
const RP = readFileSync(join(FIX, 'rp.mds'), 'utf8')

const msg = (id: string, role: string, text: string, meta?: Message['meta']): Message => ({ id, role, parts: [{ type: 'text', text }], ...(meta ? { meta } : {}) })

const card = {
  name: 'Scarlett',
  description: '{{char}} — наёмница, служит {{user}}.',
  personality: 'резкая',
  scenario: 'Таверна.',
  mes_example: '<START>\n{{char}}: Чего надо?',
  first_mes: 'Привет, {{user}}.',
}
const bot: Persona = { id: 'bot', kind: 'char', name: 'Scarlett', card }
const me = { id: 'me', kind: 'user', name: 'Ann', card: { description: '{{user}} — путница.', scenario: 'ТАЙНО' } } as Persona
const history = [msg('g', 'assistant', 'Привет, Ann.', { greeting: 0 }), msg('u1', 'user', 'Налей.')]

function input(over: Partial<BuildInput> & { template?: string; agent?: Partial<BuildInput['agent']> } = {}): BuildInput {
  const { template, agent, ...rest } = over
  return {
    session: { id: 's1' },
    document: { path: history, meta: {}, personas: [bot, me], userId: 'me' },
    model: { id: 'test-model' },
    base: [],
    tools: [],
    ...rest,
    agent: { id: 'rp', name: 'RP', prompt: { pre: 'Ты GM. {{user}} — игрок.', post: 'Не пиши за {{user}}.' }, template: template ?? RP, includes: {}, ...(agent ?? {}) },
  }
}

describe('agent.mds — голый агент', () => {
  it('system = agent.pre + base, история как есть, agent.post — после истории; .mds выхода', async () => {
    const out = await buildMdsTemplate({
      session: { id: 's' },
      document: { path: [msg('u1', 'user', 'hi')], meta: {}, personas: [] },
      agent: { id: 'a', name: 'A', systemPrompt: 'SYS', prompt: { post: 'POST' }, template: AGENT, includes: {} },
      model: { id: 'm' },
      base: [{ source: 'skills', text: 'SKILLS' }],
      tools: ['read'],
    })
    expect(out.recipe.systemBlocks).toEqual([
      { source: 'agent.pre', text: 'SYS' },
      { source: 'skills', text: 'SKILLS' },
    ])
    expect(out.nodes.map((n) => [n.role, n.source, textOf(n)])).toEqual([
      ['system', 'agent.pre', 'SYS\n\nSKILLS'],
      ['user', 'history', 'hi'],
      ['system', 'agent.post', 'POST'],
    ])
    expect(out.recipe.messageIds).toEqual(['u1'])
    expect(out.mds).toBe(
      ["%meta {model: 'm', tools: ['read']}", "%system {source: 'agent.pre'}", 'SYS', '', 'SKILLS', "%user {source: 'history', id: 'u1'}", 'hi', "%system {source: 'agent.post'}", 'POST', ''].join('\n'),
    )
  })

  it('$prompt.pre сильнее тела профиля; пустой agent.post — узел выпадает', async () => {
    const out = await buildMdsTemplate({
      session: { id: 's' },
      document: { path: [], meta: {}, personas: [] },
      agent: { id: 'a', name: 'A', systemPrompt: 'BODY', prompt: { pre: 'PRE' }, template: AGENT, includes: {} },
      model: { id: 'm' },
      base: [],
      tools: [],
    })
    expect(out.nodes.map(textOf)).toEqual(['PRE'])
  })
})

describe('rp.mds — карта в персоне', () => {
  it('блоки по источникам, подписи, макросы раскрыты на выходе', async () => {
    const out = await buildMdsTemplate(input())
    expect(out.recipe.systemBlocks).toEqual([
      { source: 'agent.pre', text: 'Ты GM. Ann — игрок.' },
      { source: 'card.description', text: "Scarlett's Persona: Scarlett — наёмница, служит Ann." },
      { source: 'card.personality', text: 'Personality: резкая' },
      { source: 'card.scenario', text: 'Scenario: Таверна.' },
      { source: 'card.mes_example', text: 'Example dialogue:\n<START>\nScarlett: Чего надо?' },
      { source: 'persona.user', text: "Ann's Persona: Ann — путница." },
    ])
    // Тайное поле персоны (scenario) боту не уходит.
    expect(out.mds).not.toContain('ТАЙНО')
    expect(out.nodes.at(-1)).toMatchObject({ role: 'user', source: 'agent.post', parts: [{ type: 'text', text: 'Не пиши за Ann.' }] })
    expect(out.recipe.injections.map((i) => i.source)).toEqual(['persona.user', 'agent.post'])
    expect(out.recipe.greeting).toBeUndefined()
  })

  it('override: meta.prompt.pre > card.system_prompt ({{original}} = agent.pre) > agent.pre; то же для post', async () => {
    const withSp: Persona = { ...bot, card: { ...card, system_prompt: 'КАРТА. {{original}}', post_history_instructions: 'ХВОСТ {{original}}' } }
    const a = await buildMdsTemplate(input({ document: { path: history, meta: {}, personas: [withSp, me], userId: 'me' } }))
    expect(a.recipe.systemBlocks[0]).toEqual({ source: 'card.system_prompt', text: 'КАРТА. Ты GM. Ann — игрок.' })
    expect(a.nodes.at(-1)).toMatchObject({ source: 'card.post_history_instructions', parts: [{ text: 'ХВОСТ Не пиши за Ann.' }] })
    const b = await buildMdsTemplate(input({ document: { path: history, meta: { prompt: { pre: 'РУЧНОЙ {{char}}', post: 'РУЧНОЙ ХВОСТ' } }, personas: [withSp, me], userId: 'me' } }))
    expect(b.recipe.systemBlocks[0]).toEqual({ source: 'meta.prompt.pre', text: 'РУЧНОЙ Scarlett' })
    expect(b.nodes.at(-1)).toMatchObject({ source: 'meta.prompt.post', parts: [{ text: 'РУЧНОЙ ХВОСТ' }] })
  })

  it('гритинг: данные выбранного (scenario) сильнее карты; индекс — в рецепте', async () => {
    const data = { index: 1, data: { scenario: 'Сцена гритинга 1 с {{user}}.' } }
    const out = await buildMdsTemplate(input({ document: { path: history, meta: {}, personas: [bot, me], userId: 'me', greeting: data } }))
    expect(out.recipe.systemBlocks.find((b) => b.source.includes('scenario'))).toEqual({ source: 'greeting[1].scenario', text: 'Scenario: Сцена гритинга 1 с Ann.' })
    expect(out.recipe.greeting).toBe(1)
    const plain = await buildMdsTemplate(input({ document: { path: history, meta: {}, personas: [bot, me], userId: 'me', greeting: { index: 2 } } }))
    expect(plain.recipe.systemBlocks.find((b) => b.source.includes('scenario'))).toEqual({ source: 'card.scenario @greeting[2]', text: 'Scenario: Таверна.' })
    expect(plain.recipe.greeting).toBe(2)
    expect(plain.mds).toContain('greeting: 2}')
  })

  it('вставки на глубине от конца ленты (с post), роль — в рецепте, сообщение — user; пустая — нет вставки', async () => {
    const withDp: Persona = { ...bot, card: { ...card, extensions: { depth_prompt: { prompt: '[{{char}} помнит {{user}}]', depth: 1, role: 'system' } } } }
    const out = await buildMdsTemplate(
      input({ document: { path: history, meta: { depthPrompt: { prompt: '', depth: 0 } }, personas: [withDp, me], userId: 'me' } }),
    )
    expect(out.nodes.slice(1).map((n) => [n.role, n.source])).toEqual([
      ['assistant', 'history'],
      ['user', 'history'],
      ['user', 'card.depth_prompt'],
      ['user', 'agent.post'],
    ])
    expect(out.recipe.injections.find((i) => i.source === 'card.depth_prompt')).toEqual({ role: 'system', text: '[Scarlett помнит Ann]', source: 'card.depth_prompt' })
    expect(out.nodes.find((n) => n.source === 'card.depth_prompt')?.injectRole).toBe('system')
  })

  it('глубины 0 и больше длины: в конец и в начало ленты; в шаблоне — выражения', async () => {
    const tpl = "%system\nS\n%user\n<{ history }>\n<{ inject at=0 role=assistant source='end' }>END<{ endinject }>\n<{ inject at=n source='start' }>START<{ endinject }>\n<{ endhistory }>\n"
    const out = await buildMdsTemplate(input({ template: tpl, agent: { extra: {} } }))
    // n не задан → 4 (дефолт глубины): лента из двух узлов — в начало.
    expect(out.nodes.map((n) => n.source)).toEqual(['template:system', 'start', 'history', 'history', 'end'])
    // Рецепт — в порядке шаблона.
    expect(out.recipe.injections.map((i) => [i.source, i.role])).toEqual([
      ['end', 'assistant'],
      ['start', 'system'],
    ])
  })

  it('impersonate (DEV-243): system без GM-инструкций бота — нейтральный промпт, факты мира и персона; инструкция с тайными полями, без post/вставок/маркера', async () => {
    const withDp: Persona = { ...bot, card: { ...card, extensions: { depth_prompt: { prompt: 'NOTE', depth: 0 } } } }
    const doc = { path: [msg('g', 'assistant', 'Привет.')], meta: {}, personas: [withDp, me], userId: 'me' }
    const imp = await buildMdsTemplate(input({ document: doc, turn: { impersonate: true, input: 'Спроси имя.' }, agent: { impersonate: "Ответь за {{user}}.\n{{scenario}}\n{{input}}" } }))
    const run = await buildMdsTemplate(input({ document: doc }))
    const sources = imp.recipe.systemBlocks.map((b) => b.source)
    expect(sources[0]).toBe('agent.impersonate_pre')
    expect(imp.recipe.systemBlocks[0]!.text).toContain("You are writing as Ann, the player's character")
    // GM-инструкции (agent.pre | card, примеры, блок участников) — не в impersonate
    expect(sources).not.toContain('agent.pre')
    expect(sources).not.toContain('card.system_prompt')
    expect(sources).not.toContain('card.mes_example')
    // факты мира и персона игрока — как у хода бота
    for (const s of run.recipe.systemBlocks.map((b) => b.source).filter((x) => ['card.description', 'card.scenario', 'persona.user'].includes(x))) expect(sources).toContain(s)
    expect(imp.nodes.slice(1).map((n) => [n.source, textOf(n)])).toEqual([
      ['history', 'Привет.'],
      ['impersonate', 'Ответь за Ann.\nТАЙНО\nСпроси имя.'],
    ])
    // Обычный ран: история кончается ответом — маркер «продолжай»; глубина 0 — после post.
    expect(run.nodes.slice(1).map((n) => n.source)).toEqual(['history', 'continue', 'agent.post', 'card.depth_prompt'])
  })

  it('impersonate (DEV-243): system_prompt персоны — главный промпт (в инструкции не повторяется), post_history — после инструкции', async () => {
    const me2 = { ...me, card: { ...me.card, system_prompt: 'Ты — {{user}}, путница.', post_history_instructions: 'Коротко.' } } as Persona
    const doc = { path: [msg('g', 'assistant', 'Привет.')], meta: {}, personas: [bot, me2], userId: 'me' }
    const imp = await buildMdsTemplate(input({ document: doc, turn: { impersonate: true, input: '' }, agent: { impersonate: 'Ответь за {{user}}.' } }))
    expect(imp.recipe.systemBlocks[0]).toMatchObject({ source: 'persona.system_prompt', text: 'Ты — Ann, путница.' })
    const tail = imp.nodes.slice(1).map((n) => [n.source, textOf(n)])
    expect(tail).toEqual([
      ['history', 'Привет.'],
      ['impersonate', 'Ответь за Ann.\n\nКоротко.'],
    ])
  })

  it('имена в ходу: префиксы по персонам, блок участников, подсказка хода в конце', async () => {
    const bob: Persona = { id: 'bob', kind: 'char', name: 'Bob', card: { description: 'Бармен.' } }
    const out = await buildMdsTemplate(
      input({
        document: { path: [msg('a1', 'assistant', 'Я Scarlett.'), msg('u1', 'user', 'Привет')], meta: {}, personas: [bot, bob, me], userId: 'me' },
        turn: { target: 'bob' },
        agent: { prompt: {} },
      }),
    )
    expect(out.recipe.systemBlocks.map((b) => b.source)).toEqual(['card.description', 'persona.user', 'persona'])
    expect(out.recipe.systemBlocks[0]!.text).toBe("Bob's Persona: Бармен.")
    expect(out.nodes.slice(1).map(textOf)).toEqual(['Scarlett: Я Scarlett.', 'Ann: Привет\nBob: '])
  })
})

describe('механика шаблона', () => {
  it('история: {{user}}/{{char}} — по текущим персонам (DEV-256)', async () => {
    const tpl = '%user\n<{ history }><{ endhistory }>\n'
    const doc = { path: [msg('g', 'assistant', 'Ты {{user}}? Я {{char}}.', { greeting: 0 })], meta: {}, personas: [bot, me], userId: 'me' }
    const out = await buildMdsTemplate(input({ template: tpl, document: doc }))
    expect(out.nodes.map(textOf)[0]).toBe('Ты Ann? Я Scarlett.')
  })

  it('%include — узлы файла как есть, с пометками; путь — как в шаблоне', async () => {
    const tpl = '%system\n<< agent.pre >>\n%include episodes.mds\n%user\n<{ history }><{ endhistory }>\n'
    const episodes = "%user\nкто ты, {{user}}?\n%assistant {source: 'ep1'}\nДжулия.\n%system hidden\nскрыто\n"
    expect(templateIncludes(tpl)).toEqual(['episodes.mds'])
    const out = await buildMdsTemplate(input({ template: tpl, agent: { includes: { 'episodes.mds': episodes } } }))
    expect(out.nodes.map((n) => [n.role, n.source, textOf(n), n.hidden ?? false])).toEqual([
      ['system', 'agent.pre', 'Ты GM. Ann — игрок.', false],
      ['user', 'include:episodes.mds', 'кто ты, {{user}}?', false],
      ['assistant', 'ep1', 'Джулия.', false],
      ['system', 'include:episodes.mds', 'скрыто', true],
      ['assistant', 'history', 'Привет, Ann.', false],
      ['user', 'history', 'Налей.', false],
    ])
    await expect(buildMdsTemplate(input({ template: tpl }))).rejects.toThrow(/%include episodes.mds — файл не прочитан/)
  })

  it('%assistant prefill — последним; пустой выпадает; не последний — ошибка', async () => {
    const tpl = '%system\nS\n<{ history }><{ endhistory }>\n%assistant prefill\n<< card.name >>:\n'
    const out = await buildMdsTemplate(input({ template: tpl }))
    expect(out.nodes.at(-1)).toMatchObject({ role: 'assistant', prefill: true, parts: [{ text: 'Scarlett:' }] })
    expect(out.recipe.injections.at(-1)).toMatchObject({ role: 'assistant', text: 'Scarlett:' })
    expect(out.mds).toContain("%assistant {source: 'template:assistant', prefill: true}")
    const empty = await buildMdsTemplate(input({ template: '%system\nS\n%assistant prefill\n<< nothing >>\n' }))
    expect(empty.nodes.map((n) => n.role)).toEqual(['system'])
    await expect(buildMdsTemplate(input({ template: '%system\nS\n%assistant prefill\nX\n%user\nY\n' }))).rejects.toThrow(/prefill — только последним/)
  })

  it('пустые узлы выпадают; %meta мержится с моделью и тулами', async () => {
    const tpl = "%meta {sampling: {temperature: 0.7}}\n%system\n<< agent.nope >>\n%user\n   \n%user\nOK\n"
    const out = await buildMdsTemplate(input({ template: tpl, tools: ['x'] }))
    expect(out.nodes.map(textOf)).toEqual(['OK'])
    expect(out.meta).toEqual({ sampling: { temperature: 0.7 }, model: 'test-model', tools: ['x'] })
  })

  it('незнакомые {{x}} остаются как написаны; macros — явное раскрытие', async () => {
    const out = await buildMdsTemplate(input({ template: "%system\n{{char}} и {{user}}, {{random}}\n<< '{{user}}!' | macros >>\n" }))
    expect(out.recipe.systemBlocks.map((b) => b.text)).toEqual(['Scarlett и Ann, {{random}}', 'Ann!'])
  })

  it('ошибки текстом: пустой шаблон, inject вне history, история дважды, текст в history, неизвестный тег, history в выражении', async () => {
    await expect(buildMdsTemplate(input({ template: 'без маркеров' }))).rejects.toThrow(/шаблон агента пуст/)
    await expect(buildMdsTemplate(input({ template: '%user\n<{ inject at=1 }>x<{ endinject }>\n' }))).rejects.toThrow(/inject }> — только внутри/)
    await expect(buildMdsTemplate(input({ template: '%user\n<{ history }><{ endhistory }>\n%user\n<{ history }><{ endhistory }>\n' }))).rejects.toThrow(/дважды/)
    await expect(buildMdsTemplate(input({ template: '%user\n<{ history }>текст<{ endhistory }>\n' }))).rejects.toThrow(/только <\{ inject \}>/)
    await expect(buildMdsTemplate(input({ template: '%user\n<{ wat }>\n' }))).rejects.toThrow(/узел #1 %user: .*unknown block tag: wat/s)
    await expect(buildMdsTemplate(input({ template: "%user\n<{ set h }><{ history }><{ endhistory }><{ endset }>\n<< 'X' ~ h >>\n" }))).rejects.toThrow(/только на верхнем уровне узла/)
  })
})

describe('реестр', () => {
  it('дефолт — mds-template; неизвестный — ошибка текстом', () => {
    const b = defaultBuilders()
    expect(resolveBuilder(b, undefined).name).toBe('mds-template')
    expect(() => resolveBuilder(b, 'nr-play')).toThrow(/билдер промпта «nr-play» не зарегистрирован/)
  })
})
