/**
 * pi — кодеки файла по расширению (`PiStoreOpts.codecs`) и pi-совместимые поля
 * сообщений (`piMessageDefaults`). Кодек здесь игрушечный (JSON-массив): драйвер
 * не знает про pi-session-mds, проверяется только диспетчеризация по расширению.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPiStore, type PiFileCodec } from '../src/pi/index.js'

const ARRAY_CODEC: PiFileCodec = {
  ext: '.arr',
  decode: (text) => JSON.parse(text) as unknown[],
  encode: (entries) => JSON.stringify(entries, null, 1),
}

const HEADER = { type: 'session', version: 3, id: 'arr-sess', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/w' }

describe('pi: codecs по расширению', () => {
  it('новая сессия пишется в newSessionExt и читается назад тем же кодеком', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-codec-'))
    const store = createPiStore({ dir, cwd: '/w', codecs: [ARRAY_CODEC], newSessionExt: '.arr' })
    const s = await store.create()
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    expect(files[0]!.endsWith(`_${s.id}.arr`)).toBe(true)

    await store.appendNode(s.id, { role: 'user', text: 'привет' })
    const raw = JSON.parse(readFileSync(join(dir, files[0]!), 'utf-8')) as Array<{ type: string }>
    expect(raw[0]!.type).toBe('session')
    expect(raw[1]!.type).toBe('message')
    const loaded = await store.load(s.id)
    expect(loaded.nodes.map((n) => n.role)).toEqual(['user'])
    expect((await store.list()).sessions.map((x) => x.id)).toEqual([s.id])
  })

  it('jsonl и файлы кодека живут в одном каталоге', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-codec-'))
    writeFileSync(join(dir, 'a.arr'), JSON.stringify([HEADER]), 'utf-8')
    writeFileSync(join(dir, 'b.jsonl'), `${JSON.stringify({ ...HEADER, id: 'jsonl-sess' })}\n`, 'utf-8')
    const store = createPiStore({ dir, codecs: [ARRAY_CODEC] })
    const ids = (await store.list()).sessions.map((x) => x.id).sort()
    expect(ids).toEqual(['arr-sess', 'jsonl-sess'])
    // Без кодека `.arr` невидим — прежнее поведение.
    expect((await createPiStore({ dir }).list()).sessions.map((x) => x.id)).toEqual(['jsonl-sess'])
  })

  it('newSessionExt без кодека — ошибка сборки, а не тихий jsonl', () => {
    expect(() => createPiStore({ dir: tmpdir(), newSessionExt: '.mds' })).toThrow(/no codec/)
  })
})

describe('pi: piMessageDefaults', () => {
  it('assistant получает api/provider/model/usage/stopReason, всё — timestamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-def-'))
    const store = createPiStore({ dir, piMessageDefaults: { api: 'openai-completions', provider: 'nr' } })
    const s = await store.create()
    await store.appendNode(s.id, { role: 'user', text: 'q' })
    await store.appendNode(s.id, {
      role: 'assistant',
      parts: [{ type: 'tool_use', data: { q: 1 }, meta: { callId: 'c1', name: 'web_search' } }],
      meta: { model: 'glm-5.3-flash', usage: { input: 10, output: 3 } },
    })
    await store.appendNode(s.id, {
      role: 'tool',
      parts: [{ type: 'tool_result', text: 'ok', meta: { callId: 'c1', name: 'web_search' } }],
    })
    await store.appendNode(s.id, { role: 'assistant', parts: [{ type: 'text', text: 'ча' }], meta: { cancelled: true } })

    const file = readdirSync(dir)[0]!
    const lines = readFileSync(join(dir, file), 'utf-8').trim().split('\n').map((l) => JSON.parse(l))
    const msgs = lines.slice(1).map((e) => e.message)
    for (const m of msgs) expect(typeof m.timestamp).toBe('number')
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      api: 'openai-completions',
      provider: 'nr',
      model: 'glm-5.3-flash',
      stopReason: 'toolUse',
      usage: { input: 10, output: 3, totalTokens: 13 },
    })
    expect(msgs[2]).toMatchObject({ role: 'toolResult', toolCallId: 'c1', toolName: 'web_search', isError: false })
    expect(msgs[3]).toMatchObject({ stopReason: 'aborted', model: 'unknown' })

    // Узлы назад — как писались (fidelity), роль tool и парт tool_result.
    const nodes = (await store.load(s.id)).nodes
    expect(nodes.map((n) => n.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(nodes[2]!.parts[0]).toMatchObject({ type: 'tool_result', text: 'ok' })
  })

  it('без опции сообщения пишутся как раньше', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-def-'))
    const store = createPiStore({ dir })
    const s = await store.create()
    await store.appendNode(s.id, { role: 'assistant', text: 'a' })
    const file = readdirSync(dir)[0]!
    const entry = JSON.parse(readFileSync(join(dir, file), 'utf-8').trim().split('\n')[1]!)
    expect(entry.message.api).toBeUndefined()
    expect(entry.message.timestamp).toBeUndefined()
  })
})
