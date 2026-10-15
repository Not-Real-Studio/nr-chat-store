/**
 * Тег `<{ project }>` (spaces-spec §4, DEV-319): контекст проекта и скиллы
 * старта — блоками хоста после system агента; префикс агента от проекта не зависит.
 */

import { describe, expect, it } from 'vitest'
import { buildMdsTemplate, type BuildInput, type PrefixBlock } from '../src/builder/index.js'
import { textOf } from '../src/assembly/index.js'

const AGENT = `%meta {name: "A"}
%system
Ты агент.
%system
Второй блок агента.
%user
<{ history }><{ endhistory }>
`

function input(project: PrefixBlock[] | undefined, template = AGENT): BuildInput {
  return {
    session: { id: 's' },
    document: { path: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], meta: {}, personas: [] },
    agent: { id: 'a', name: 'A', template, includes: {}, ...(project ? { project } : {}) },
    model: { id: 'm' },
    base: [],
    tools: [],
  }
}

const twin: PrefixBlock[] = [{ source: 'project', text: 'Проект twin-jester (/g/twin-jester)\n<file path="/g/twin-jester.dev/SKILL.md">\nTJ\n</file>' }]
const meadow: PrefixBlock[] = [
  { source: 'project', text: 'Проект meadow-fortune (/g/meadow-fortune)' },
  { source: 'skill:use-gamekit', text: 'GAMEKIT' },
]

describe('тег project', () => {
  it('тега нет — после первого %system агента; префикс агента байт-в-байт тот же', async () => {
    const a = textOf((await buildMdsTemplate(input(twin))).nodes[0]!)
    const b = textOf((await buildMdsTemplate(input(meadow))).nodes[0]!)
    const bare = textOf((await buildMdsTemplate(input(undefined))).nodes[0]!)
    expect(bare).toBe('Ты агент.')
    expect(a.startsWith('Ты агент.\n\nПроект twin-jester')).toBe(true)
    expect(b).toBe('Ты агент.\n\nПроект meadow-fortune (/g/meadow-fortune)\n\nGAMEKIT')
    expect(a.slice(0, bare.length)).toBe(b.slice(0, bare.length))
  })

  it('блоки — со своими источниками (рецепт)', async () => {
    const out = await buildMdsTemplate(input(meadow))
    const sources = out.recipe.systemBlocks.map((x) => x.source)
    expect(sources).toEqual(expect.arrayContaining(['project', 'skill:use-gamekit']))
  })

  it('project: false в %meta — без контекста проекта, скиллы остаются', async () => {
    const out = await buildMdsTemplate(input(meadow, AGENT.replace('{name: "A"}', '{name: "A", project: false}')))
    expect(textOf(out.nodes[0]!)).toBe('Ты агент.\n\nGAMEKIT')
  })

  it('явный тег — на своём месте', async () => {
    const tpl = `%system\nДо.\n%system\n<{ project }>\nПосле.\n%user\n<{ history }><{ endhistory }>\n`
    const out = await buildMdsTemplate(input(meadow, tpl))
    expect(textOf(out.nodes[0]!)).toBe('До.')
    expect(textOf(out.nodes[1]!)).toBe('Проект meadow-fortune (/g/meadow-fortune)\n\nGAMEKIT\n\nПосле.')
    const empty = await buildMdsTemplate(input(undefined, tpl))
    expect(textOf(empty.nodes[1]!)).toBe('После.')
  })
})

describe('тег project: узел с историей', () => {
  it('первый %system с <{ history }> — проект перед историей (system)', async () => {
    const tpl = `%system\n<< agent.pre >>\n\n<{ history }><{ endhistory }>\n\n%system\nPOST\n`
    const inp = input(meadow, tpl)
    inp.agent.systemPrompt = 'AG'
    const out = await buildMdsTemplate(inp)
    expect(textOf(out.nodes[0]!)).toBe('AG\n\nПроект meadow-fortune (/g/meadow-fortune)\n\nGAMEKIT')
    expect(out.nodes[1]!.role).toBe('user')
  })
})
