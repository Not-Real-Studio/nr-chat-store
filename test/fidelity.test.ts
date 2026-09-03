/**
 * Fidelity — политика «escape hatch обязателен» (spec §3). Сообщение со ВСЕМИ
 * типами Part (+ text+data-комбинации) + все flags + произвольный node.meta:
 * append → load → deep-equal частей/флагов, meta — суперсет с провайдед-ключами.
 * Прогон на тройке драйверов: неподдержанное нативно выживает через nrs*-канал.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MessageFlags, Part, SessionStore } from '../src/index.js'
import { createNrChatStore } from '../src/nr-chat/index.js'
import { createPiStore } from '../src/pi/index.js'
import { createClaudeStore } from '../src/claude/index.js'

const drivers: { name: string; make: () => SessionStore }[] = [
  { name: 'nr-chat', make: () => createNrChatStore({ dir: mkdtempSync(join(tmpdir(), 'fid-mds-')) }) },
  { name: 'pi', make: () => createPiStore({ dir: mkdtempSync(join(tmpdir(), 'fid-pi-')), cwd: '/w' }) },
  { name: 'claude', make: () => createClaudeStore({ dir: mkdtempSync(join(tmpdir(), 'fid-cl-')), cwd: '/w' }) },
]

/** One node holding every Part type + text+data combinations. `text` is first (nr-chat body). */
const ALL_PARTS: Part[] = [
  { type: 'text', text: 'ведущий текст' },
  { type: 'thinking', text: 'рассуждение', meta: { signature: 'sig-abc' } },
  { type: 'tool_use', data: { expr: '2+2' }, meta: { callId: 'c1', name: 'calc' } },
  // text+data вместе: data — истина, text — извлечённый текст.
  { type: 'tool_result', data: { rows: 214 }, text: 'таблица', meta: { callId: 'c1', name: 'calc' } },
  // tool_result только с data (без text).
  { type: 'tool_result', data: { ok: true }, meta: { callId: 'c2', name: 'ping', error: true } },
  { type: 'file', text: 'извлечённый текст файла', meta: { name: 'report.pdf', mime: 'application/pdf', ref: 'file:s.assets/r.pdf' } },
  { type: 'image', text: 'OCR картинки', meta: { mime: 'image/png', url: 'data:image/png;base64,AAAA', alt: 'схема' } },
  { type: 'error', text: 'сломалось', meta: { code: 'E_OOPS' } },
  { type: 'custom', data: { widget: 'poll' }, text: 'голосование', meta: { hint: 'poll', extra: 7 } },
  { type: 'custom', text: 'только текст', meta: { hint: 'note' } },
]

// hidden — legacy-вход: драйвер маппит в disabled на записи/чтении; round-trip держат новые оси.
const FLAGS: MessageFlags = { visible: false, disabled: true, frozen: true, injected: true }
const META = { model: 'gpt-x', foo: 'bar', nested: { a: 1 } }

for (const driver of drivers) {
  describe(`fidelity: ${driver.name}`, () => {
    it('все типы Part + flags + meta переживают append→load', async () => {
      const store = driver.make()
      const { id } = await store.create({})
      const appended = await store.appendNode(id, { role: 'assistant', parts: ALL_PARTS, flags: FLAGS, meta: META })

      // Возврат из appendNode уже несёт полную модель.
      expect(appended.parts).toEqual(ALL_PARTS)
      expect(appended.flags).toEqual(FLAGS)
      expect(appended.meta).toMatchObject(META)

      // …и переживает перечитывание с диска.
      const model = await store.load(id)
      const node = model.nodes.find((n) => n.id === appended.id)!
      expect(node.parts).toEqual(ALL_PARTS)
      expect(node.flags).toEqual(FLAGS)
      expect(node.meta).toMatchObject(META)
    })
  })
}
