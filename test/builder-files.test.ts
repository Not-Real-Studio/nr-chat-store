/**
 * Тег `<{ files "glob", … }>` (session-document-spec §4.5, DEV-275): билдер
 * раскрывает файлы, прочитанные хостом, блоками `<file path>` по возрастанию
 * пути; хост — `readTemplateFiles` (глобы `~`, относительные от шаблона, `**`).
 */

import { describe, expect, it } from 'vitest'
import { buildMdsTemplate, globRegExp, readTemplateFiles, templateFileGlobs, type BuildInput } from '../src/builder/index.js'
import { textOf } from '../src/assembly/index.js'

const TPL = `%system
Ты помощник.
<{ files "docs/*.md", "~/notes/memory.md" }>

<{ history }><{ endhistory }>
`

function input(files: BuildInput['agent']['files'], template = TPL): BuildInput {
  return {
    session: { id: 's' },
    document: { path: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }], meta: {}, personas: [] },
    agent: { id: 'a', name: 'A', template, includes: {}, ...(files ? { files } : {}) },
    model: { id: 'm' },
    base: [],
    tools: [],
  }
}

/** Память-ФС: путь → текст. */
function memFs(files: Record<string, string>) {
  return {
    readText: async (p: string) => files[p],
    list: async (dir: string) => Object.keys(files).filter((p) => p.startsWith(dir.endsWith('/') ? dir : `${dir}/`)),
  }
}

describe('тег files', () => {
  it('блоки <file path> по возрастанию пути, дубли между глобами — один раз', async () => {
    const out = await buildMdsTemplate(
      input({
        'docs/*.md': [
          { path: '/t/docs/b.md', text: 'B\n' },
          { path: '/t/docs/a.md', text: 'A' },
        ],
        '~/notes/memory.md': [{ path: '/t/docs/a.md', text: 'A' }],
      }),
    )
    const sys = textOf(out.nodes[0]!)
    expect(sys).toBe('Ты помощник.\n<file path="/t/docs/a.md">\nA\n</file>\n\n<file path="/t/docs/b.md">\nB\n</file>')
  })

  it('глоб без файлов — пусто; глоба нет во входе — ошибка как у %include', async () => {
    const out = await buildMdsTemplate(input({ 'docs/*.md': [], '~/notes/memory.md': [] }))
    expect(textOf(out.nodes[0]!)).toBe('Ты помощник.')
    await expect(buildMdsTemplate(input(undefined))).rejects.toThrow(/files "docs\/\*\.md".*не прочитаны/)
  })

  it('файл в user-узле до истории — текстом, не вызовом тула', async () => {
    const tpl = `%system\nS\n%user\n<{ files "a.md" }>\n%assistant\nПрочитал.\n%user\n<{ history }><{ endhistory }>\n`
    const out = await buildMdsTemplate(input({ 'a.md': [{ path: '/p/a.md', text: 'skill' }] }, tpl))
    expect(out.nodes.map((n) => n.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(textOf(out.nodes[1]!)).toBe('<file path="/p/a.md">\nskill\n</file>')
  })
})

describe('readTemplateFiles', () => {
  it('глобы шаблона: строки в обеих кавычках, без повторов', () => {
    expect(templateFileGlobs(`<{ files "a/*.md", 'b.md' }>\n<{- files "a/*.md" -}>`)).toEqual(['a/*.md', 'b.md'])
  })

  it('регэксп глоба: *, ?, **, {a,b}', () => {
    expect(globRegExp('/x/*.md').test('/x/a.md')).toBe(true)
    expect(globRegExp('/x/*.md').test('/x/y/a.md')).toBe(false)
    expect(globRegExp('/x/**/*.md').test('/x/a.md')).toBe(true)
    expect(globRegExp('/x/**/*.md').test('/x/y/z/a.md')).toBe(true)
    expect(globRegExp('/x/?.{md,txt}').test('/x/a.txt')).toBe(true)
    expect(globRegExp('/x/?.{md,txt}').test('/x/ab.txt')).toBe(false)
  })

  it('относительный — от каталога шаблона, ~ — от home; нет файла — пусто; по возрастанию пути', async () => {
    const fs = memFs({ '/tpl/docs/b.md': 'B', '/tpl/docs/a.md': 'A', '/tpl/docs/sub/c.md': 'C', '/home/u/notes/memory.md': 'M' })
    const files = await readTemplateFiles(TPL + '<{ files "none.md" }>', { dir: '/tpl', home: '/home/u', fs })
    expect(files).toEqual({
      'docs/*.md': [
        { path: '/tpl/docs/a.md', text: 'A' },
        { path: '/tpl/docs/b.md', text: 'B' },
      ],
      '~/notes/memory.md': [{ path: '/home/u/notes/memory.md', text: 'M' }],
      'none.md': [],
    })
  })
})
