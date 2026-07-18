/**
 * Сквозная конверсия (spec §8): сессия в драйвере A → load → create+append в
 * драйвер B → load → структурное равенство активного пути (id/время у драйверов
 * свои, роли и части — общий знаменатель модели).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { toHistory, type Message, type SessionModel, type SessionStore } from '../src/index.js'
import { createNrChatStore } from '../src/nr-chat/index.js'
import { createPiStore } from '../src/pi/index.js'
import { createClaudeStore } from '../src/claude/index.js'

/** Структурная форма активного пути: роль + типы/тексты частей. */
function shape(model: SessionModel): unknown {
  return toHistory(model).map((m: Message) => ({
    role: m.role,
    parts: m.parts.map((p) => ({ type: p.type, text: 'text' in p ? p.text : undefined })),
  }))
}

/** Перелить активный путь исходной модели в целевой драйвер через append. */
async function replay(target: SessionStore, source: SessionModel): Promise<string> {
  const { id } = await target.create({})
  for (const m of toHistory(source)) {
    await target.appendNode(id, { role: m.role, parts: m.parts })
  }
  return id
}

const mds = () => createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'mds-')) })
const pi = () => createPiStore({ dir: mkdtempSync(join(tmpdir(), 'pi-')), cwd: '/w' })
const claude = () => createClaudeStore({ dir: mkdtempSync(join(tmpdir(), 'cl-')), cwd: '/w' })

/** Наполнить драйвер осмысленным диалогом (текст, thinking, tool). */
async function seedDialog(store: SessionStore): Promise<string> {
  const { id } = await store.create({})
  await store.appendNode(id, { role: 'user', text: 'посчитай 2+2' })
  await store.appendNode(id, {
    role: 'assistant',
    parts: [
      { type: 'thinking', text: 'считаю' },
      { type: 'tool_use', data: { expr: '2+2' }, meta: { callId: 'c1', name: 'calc' } },
    ],
  })
  await store.appendNode(id, {
    role: 'tool',
    parts: [{ type: 'tool_result', text: '4', meta: { callId: 'c1', name: 'calc' } }],
  })
  await store.appendNode(id, { role: 'assistant', text: 'четыре' })
  return id
}

describe('cross-conversion', () => {
  it('pi → mds: активный путь структурно совпадает', async () => {
    const src = pi()
    const srcId = await seedDialog(src)
    const srcModel = await src.load(srcId)

    const dst = mds()
    const dstId = await replay(dst, srcModel)
    const dstModel = await dst.load(dstId)

    expect(shape(dstModel)).toEqual(shape(srcModel))
  })

  it('mds → pi → claude: форма сохраняется по цепочке', async () => {
    const a = mds()
    const aModel = await a.load(await seedDialog(a))

    const b = pi()
    const bModel = await b.load(await replay(b, aModel))
    expect(shape(bModel)).toEqual(shape(aModel))

    const c = claude()
    const cModel = await c.load(await replay(c, bModel))
    expect(shape(cModel)).toEqual(shape(aModel))
  })
})
