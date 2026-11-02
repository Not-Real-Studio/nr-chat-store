/**
 * Метки субагента у тулов (протокол v1.60, DEV-616): `parent` и `subagentContext`
 * переживают круг part → %%sub-нода → part; без меток — как было.
 */

import { describe, it, expect } from 'vitest'
import { partToSubMessage, subNodeToPart } from '../src/nr-chat/parts.js'
import type { Part } from '../src/model.js'

const round = (part: Part): Part => {
  const m = partToSubMessage(part)
  return subNodeToPart({ kind: m.role.slice(1), name: m.name, meta: m.meta, body: m.body } as never)
}

describe('метки субагента', () => {
  it('tool_use с parent', () => {
    const part: Part = { type: 'tool_use', data: { path: 'a.md' }, meta: { callId: 'c1', name: 'Read', parent: 'agent1' } }
    expect(round(part)).toEqual(part)
  })
  it('tool_result с parent и subagentContext', () => {
    const part: Part = { type: 'tool_result', text: 'ok', meta: { callId: 'c1', name: 'Read', parent: 'agent1', subagentContext: 41000 } }
    expect(round(part)).toEqual(part)
  })
  it('без меток — мета прежняя', () => {
    const m = partToSubMessage({ type: 'tool_use', data: {}, meta: { callId: 'c2', name: 'Bash' } })
    expect(m.meta).toEqual({ callId: 'c2', name: 'Bash' })
  })
})
