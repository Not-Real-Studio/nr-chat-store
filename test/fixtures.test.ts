/**
 * Фикстуры реалистичной формы (spec §8): декодеры драйверов на «реальных»
 * данных — model_change/toolResult (pi), tool_use/tool_result/summary + пропуск
 * meta-строк (claude), `%%`-суб-ноды (mds), скип битых строк.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toHistory } from '../src/index.js'
import { createNrChatStore } from '../src/nr-chat/index.js'
import { createPiStore } from '../src/pi/index.js'
import { createClaudeStore } from '../src/claude/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const fx = (sub: string) => join(here, 'fixtures', sub)

describe('fixtures: pi', () => {
  it('декодит thinking/toolCall/toolResult, скипает битую строку', async () => {
    const s = createPiStore({ dir: fx('pi'), cwd: '/work' })
    const model = await s.load('pi-fix-1')
    const hist = toHistory(model)
    // model_change — узел дерева (custom), потому 5 узлов на активном пути.
    expect(hist.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'tool'])
    const assistant = hist[1]
    expect(assistant.parts.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_use'])
    expect(assistant.meta?.model).toBe('opus')
    expect(assistant.meta?.usage).toEqual({ input: 10, output: 5 })
    const toolResult = hist[3]
    expect(toolResult.parts[0]).toMatchObject({ type: 'tool_result', text: 'file1' })
  })
})

describe('fixtures: claude', () => {
  it('декодит content-блоки, summary как custom, скипает meta-строки без uuid', async () => {
    const s = createClaudeStore({ dir: fx('claude'), cwd: '/work' })
    const model = await s.load('session')
    // u1, a1, u2 — узлы; summary(без uuid) и mode — пропущены.
    expect(model.nodes.map((n) => n.id)).toEqual(['u1', 'a1', 'u2'])
    const assistant = model.nodes[1]
    expect(assistant.parts.map((p) => p.type)).toEqual(['thinking', 'text', 'tool_use'])
    const toolTurn = model.nodes[2]
    expect(toolTurn.parts[0]).toMatchObject({ type: 'tool_result', text: 'file1\nfile2' })
  })
})

describe('fixtures: mds', () => {
  it('декодит %%-суб-ноды в parts, разворачивает дерево', async () => {
    const s = createNrChatStore({ dir: fx('mds') })
    const model = await s.load('session')
    const hist = toHistory(model)
    expect(hist.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(hist[1].parts.map((p) => p.type)).toEqual(['text', 'thinking'])
    expect(hist[1].parts[1]).toMatchObject({ type: 'thinking', text: 'размышление' })
  })
})
