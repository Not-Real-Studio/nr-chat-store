import { describe, expect, it } from 'vitest'
import { agentDocOf, agentText, agentVoiceOf, isAgentFile } from '../src/builder/index.js'

const TEXT = `%meta {name: "nrchat", description: "рабочий", engine: "claude-acp", model: "opus", card: "denis", cwd: "~/x"}
%%tools
all
%system
Ты — агент. <{ files "a.md" }>
%include nrchat.example.mds
%user
<{ history }><{ endhistory }>
`

describe('агент .mds ↔ ProfileDoc (DEV-314)', () => {
  it('файлы каталога', () => {
    expect(isAgentFile('a.mds')).toBe(true)
    expect(isAgentFile('a.example.mds')).toBe(false)
    expect(isAgentFile('.a.mds')).toBe(false)
    expect(isAgentFile('a.mdz')).toBe(false)
  })

  it('мета → документ, шаблон — сам файл', () => {
    const d = agentDocOf('nrchat', TEXT, '/e/agents/nrchat.mds')
    expect(d).toMatchObject({ id: 'nrchat', name: 'nrchat', description: 'рабочий', engine: 'claude-acp', model: 'opus', card: 'denis', template: '/e/agents/nrchat.mds', source: 'agents', tools: 'all' })
  })

  it('прочие поля меты — в extra текстом (tool_policy, max_turns): движок nr читает их оттуда', () => {
    const d = agentDocOf('p', '%meta {engine: "nr", tool_policy: {exec: "auto"}, max_turns: 200, cwd: "~/x"}\n%system\nx\n', '/e/agents/p.mds')
    expect(d.extra).toEqual({ tool_policy: '{"exec":"auto"}', max_turns: '200', cwd: '~/x' })
    expect(agentDocOf('nrchat', TEXT, '/f').extra).toEqual({ cwd: '~/x' })
  })

  it('сохранение меняет только строку %meta, чужие ключи на месте', () => {
    const d = agentDocOf('nrchat', TEXT, '/e/agents/nrchat.mds')
    const out = agentText({ ...d, model: 'sonnet', engine: undefined, description: 'новое' }, TEXT)
    const back = agentDocOf('nrchat', out, '/x.mds')
    expect(back.model).toBe('sonnet')
    expect(back.engine).toBeUndefined()
    expect(back.description).toBe('новое')
    expect(out).toContain('cwd:')
    expect(out.split('\n').slice(1).join('\n')).toBe(TEXT.split('\n').slice(1).join('\n'))
  })

  it('новый агент из старого профиля nr: systemPrompt → %system, история в конце', () => {
    const out = agentText({ id: 'agent', name: 'Agent', systemPrompt: 'Будь краток.', tools: ['read', 'bash'], model: 'm1' })
    expect(out).toMatch(/^%meta \{/)
    expect(out).toContain('%system\nБудь краток.')
    expect(out.trimEnd().endsWith('<{ history }><{ endhistory }>')).toBe(true)
    const back = agentDocOf('agent', out, '/a.mds')
    expect(back).toMatchObject({ name: 'Agent', model: 'm1', tools: ['read', 'bash'] })
  })

  it('voice меты → документ (LLM-12): незнакомое отбрасывается, в extra не уходит', () => {
    const d = agentDocOf('sw', '%meta {name: "storywriter", voice: {mode: "verbatim", refine: "always"}}\n%system\nx\n', '/e/agents/sw.mds')
    expect(d.voice).toEqual({ mode: 'verbatim', refine: 'always' })
    expect(d.extra).toBeUndefined()
    expect(agentDocOf('a', '%meta {voice: {mode: "loud", refine: "always"}}\n%system\nx\n', '/a.mds').voice).toEqual({ refine: 'always' })
    expect(agentDocOf('a', '%meta {voice: {mode: "loud"}}\n%system\nx\n', '/a.mds').voice).toBeUndefined()
    expect(agentDocOf('nrchat', TEXT, '/f').voice).toBeUndefined()
    expect(agentVoiceOf('verbatim')).toBeUndefined()
  })

  it('voice переживает сохранение: правится документом, тело на месте', () => {
    const text = '%meta {name: "storywriter", voice: {mode: "verbatim", refine: "always"}, cwd: "~/x"}\n%system\nx\n'
    const d = agentDocOf('sw', text, '/e/agents/sw.mds')
    expect(agentDocOf('sw', agentText({ ...d, model: 'm1' }, text), '/x.mds').voice).toEqual({ mode: 'verbatim', refine: 'always' })
    const off = agentText({ ...d, voice: { mode: 'smart', refine: 'off' } }, text)
    expect(agentDocOf('sw', off, '/x.mds').voice).toEqual({ mode: 'smart', refine: 'off' })
    expect(agentText({ ...d, voice: undefined }, text)).not.toContain('voice')
    expect(off.split('\n').slice(1).join('\n')).toBe('%system\nx\n')
  })
})
