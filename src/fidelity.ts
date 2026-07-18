/**
 * @notrealstudio/nr-chat-store — fidelity sidechannel (spec §3).
 *
 * Policy "escape hatch is mandatory": a driver whose native format can't carry a
 * Part type, a flag, or a meta key must not drop it. It parks the WHOLE neutral
 * node (role/parts/flags/meta) in a vendor sidechannel — extra `nrs*` fields the
 * native reader ignores (pi/claude records both tolerate unknown keys) — and
 * reconstructs from it on load. Native content is still written alongside for the
 * format's own tooling; our read prefers the sidechannel when present, so foreign
 * files (no `nrs*`) decode natively as before.
 *
 * The sidechannel is authoritative for content and flags: any mutation that
 * changes them (e.g. edit, hide) must keep it in sync (`setSidechannelParts` /
 * `setSidechannelFlags`), otherwise a stale copy would shadow the edit.
 */

import type { MessageFlags, Part } from './model.js'

const F_ROLE = 'nrsRole'
const F_NAME = 'nrsName'
const F_PARTS = 'nrsParts'
const F_FLAGS = 'nrsFlags'
const F_META = 'nrsMeta'

export interface Sidechannel {
  role: string
  name?: string
  parts: Part[]
  flags?: MessageFlags
  meta?: Record<string, unknown>
}

/** Park the neutral node on a JSONL record as `nrs*` fields (§3). */
export function writeSidechannel(
  rec: Record<string, unknown>,
  role: string,
  parts: Part[],
  flags?: MessageFlags,
  meta?: Record<string, unknown>,
  name?: string,
): void {
  rec[F_ROLE] = role
  rec[F_PARTS] = parts
  if (name !== undefined) rec[F_NAME] = name
  if (flags && Object.keys(flags).length) rec[F_FLAGS] = flags
  if (meta && Object.keys(meta).length) rec[F_META] = meta
}

/** Read the sidechannel back, or `undefined` when the record has none (foreign file). */
export function readSidechannel(rec: Record<string, unknown>): Sidechannel | undefined {
  const parts = rec[F_PARTS]
  const role = rec[F_ROLE]
  if (!Array.isArray(parts) || typeof role !== 'string') return undefined
  const out: Sidechannel = { role, parts: parts as Part[] }
  if (typeof rec[F_NAME] === 'string') out.name = rec[F_NAME] as string
  const flags = rec[F_FLAGS]
  if (flags && typeof flags === 'object') out.flags = flags as MessageFlags
  const meta = rec[F_META]
  if (meta && typeof meta === 'object') out.meta = meta as Record<string, unknown>
  return out
}

/** True when the record carries a sidechannel (used to gate native vs. sidechannel decode). */
export function hasSidechannel(rec: Record<string, unknown>): boolean {
  return Array.isArray(rec[F_PARTS]) && typeof rec[F_ROLE] === 'string'
}

/** Keep the sidechannel parts in sync after a content mutation. */
export function setSidechannelParts(rec: Record<string, unknown>, parts: Part[]): void {
  if (hasSidechannel(rec)) rec[F_PARTS] = parts
}

/** Keep the sidechannel flags in sync after a flag mutation (empty → remove the field). */
export function setSidechannelFlags(rec: Record<string, unknown>, flags: MessageFlags | undefined): void {
  if (!hasSidechannel(rec)) return
  if (flags && Object.keys(flags).length) rec[F_FLAGS] = flags
  else delete rec[F_FLAGS]
}
