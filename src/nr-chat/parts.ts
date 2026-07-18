/**
 * nr-chat codec — the sub-node ↔ model Part dictionary (§4).
 *
 * One level of `%%` sub-nodes, flattened into the model's `Part[]`. A known role
 * → the matching Part; an unknown `%%role` → `custom` with `hint = role`
 * (graceful degradation, mirroring the protocol §1.2). The parent body is the
 * first text-part (§4).
 *
 * `Part` comes from the message-anatomy home (`../model.js`); the protocol
 * re-exports the very same type (chat-store-spec §1 inversion).
 */

import { parseJson5, stringifyJson5 } from '@notrealstudio/nr-chat'
import type { ChatMessage } from '@notrealstudio/nr-chat'
import type { Part } from '../model.js'
import type { SessionNode, SubNode } from './session.js'

function metaStr(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = meta?.[key]
  return typeof v === 'string' ? v : undefined
}

/** Body decoders keyed by `format` (§4/§6): injected by the consumer, the lib pulls no codecs. */
export type PartDecoders = Record<string, (body: string) => unknown>

/**
 * Decode a body by its `format` (§4): `json5` is free (nr-chat), an injected
 * decoder is used if provided; an unknown/absent format → the raw string, not an
 * error. `json5Default` is the role's default when no format is present (tool_use).
 */
function decodeBody(
  body: string,
  format: string | undefined,
  decoders: PartDecoders | undefined,
  json5Default = false,
): unknown {
  if (format === undefined) return json5Default ? parseData(body) : body
  if (format === 'json5') return parseData(body)
  const dec = decoders?.[format]
  if (dec) {
    try {
      return dec(body)
    } catch {
      return body
    }
  }
  return body
}

/** Decode a sub-node body by its `format` (for the header sessionMeta, §2). */
export function decodeSubBody(sub: SubNode, decoders?: PartDecoders): unknown {
  return decodeBody(sub.body, typeof sub.meta?.format === 'string' ? sub.meta.format : undefined, decoders)
}

/** JSON5 sub-node body → data. An empty/broken body degrades to raw text. */
function parseData(body: string): unknown {
  const trimmed = body.trim()
  if (trimmed === '') return undefined
  try {
    return parseJson5(trimmed)
  } catch {
    return body
  }
}

/**
 * Sub-node → Part by the core dictionary (§4). An unknown role → `custom` with
 * `hint = kind`.
 */
export function subNodeToPart(sub: SubNode, decoders?: PartDecoders): Part {
  const meta = sub.meta
  switch (sub.kind) {
    case 'text':
      return { type: 'text', text: sub.body }

    case 'thinking': {
      const signature = metaStr(meta, 'signature')
      return signature !== undefined
        ? { type: 'thinking', text: sub.body, meta: { signature } }
        : { type: 'thinking', text: sub.body }
    }

    case 'tool_use':
      return {
        type: 'tool_use',
        data: decodeBody(sub.body, metaStr(meta, 'format'), decoders, true),
        meta: { callId: metaStr(meta, 'callId') ?? '', name: metaStr(meta, 'name') ?? '' },
      }

    case 'tool_result': {
      const m: { callId: string; name?: string; error?: boolean } = {
        callId: metaStr(meta, 'callId') ?? '',
      }
      const name = metaStr(meta, 'name')
      if (name !== undefined) m.name = name
      if (meta?.error === true) m.error = true
      // text+data (§2): a `format` means the body IS data — decode it, and the
      // original text (if any) was parked in meta.text. No format → body is text.
      const fmt = metaStr(meta, 'format')
      if (fmt !== undefined) {
        const out: Part = { type: 'tool_result', data: decodeBody(sub.body, fmt, decoders), meta: m }
        const t = metaStr(meta, 'text')
        if (t !== undefined) out.text = t
        return out
      }
      return { type: 'tool_result', text: sub.body, meta: m }
    }

    case 'attach': {
      // file vs image is decided by mime (§4). The marker name-field = display
      // name, a `file:` ref → meta.ref. Extracted text (the body) rides into the
      // session model as `part.text` (§2): it is what goes to the LLM, and it
      // must round-trip — losing it on edit was p.4 of the review.
      const mime = metaStr(meta, 'mime')
      const ref = metaStr(meta, 'file')
      const url = metaStr(meta, 'url')
      if (mime && mime.startsWith('image/')) {
        const img: Part = { type: 'image', meta: {} }
        const m = img.meta as { mime?: string; ref?: string; url?: string; alt?: string }
        if (mime) m.mime = mime
        if (ref) m.ref = ref
        if (url) m.url = url
        if (sub.name) m.alt = sub.name
        if (sub.body !== '') img.text = sub.body
        return img
      }
      const file: Part = { type: 'file', meta: { name: sub.name ?? '' } }
      const m = file.meta as { name: string; mime?: string; ref?: string; url?: string }
      if (mime) m.mime = mime
      if (ref) m.ref = ref
      if (url) m.url = url
      if (sub.body !== '') file.text = sub.body
      return file
    }

    case 'error': {
      const code = metaStr(meta, 'code')
      return code !== undefined
        ? { type: 'error', text: sub.body, meta: { code } }
        : { type: 'error', text: sub.body }
    }

    case 'custom': {
      // text+data (§2): a `format` means the body IS data; the original text was
      // parked in meta.text. `format`/`text` are structural keys — the rest of
      // the marker meta passes through into the part meta (open dictionary).
      const fmt = metaStr(meta, 'format')
      const passthrough = { ...(meta ?? {}) }
      delete passthrough.format
      delete passthrough.text
      const out: Part = { type: 'custom', meta: { hint: metaStr(meta, 'hint') ?? 'custom', ...passthrough } }
      if (fmt !== undefined) {
        ;(out as { data?: unknown }).data = decodeBody(sub.body, fmt, decoders)
        const t = metaStr(meta, 'text')
        if (t !== undefined) out.text = t
      } else {
        out.text = sub.body
      }
      return out
    }

    default:
      // Unknown `%%role` → custom, hint = role (§4).
      return { type: 'custom', text: sub.body, meta: { hint: sub.kind, ...(meta ?? {}) } }
  }
}

/**
 * Assemble a regular node's `parts`: the body = the first text-part (if it is
 * non-empty, or there are no sub-nodes — otherwise there is simply no leading
 * text), then the sub-nodes by the dictionary.
 */
export function assembleParts(node: SessionNode, decoders?: PartDecoders): Part[] {
  const parts: Part[] = []
  if (node.body !== '' || node.subNodes.length === 0) {
    parts.push({ type: 'text', text: node.body })
  }
  for (const sub of node.subNodes) parts.push(subNodeToPart(sub, decoders))
  return parts
}

/**
 * text+data serialization (§2): `data` is the truth — it becomes the body with an
 * auto `format: 'json5'` (always set when the body is derived from data, so the
 * reverse read knows to decode it); a coexisting `text` is parked in `meta.text`.
 * No data → `text` is the body verbatim, no format. Mutates `meta` in place;
 * returns the body.
 */
function writeTextData(text: string | undefined, data: unknown, meta: Record<string, unknown>): string {
  if (data !== undefined) {
    meta.format = 'json5'
    if (text !== undefined) meta.text = text
    // Always JSON5-encode (even a string) so `format:'json5'` decodes back to the
    // exact value — a raw string body like "42" would otherwise read back as a number.
    return stringifyJson5(data)
  }
  return text ?? ''
}

/** Sub-node role by Part type (the reverse of the dictionary, for serialization). */
const PART_TYPE_TO_ROLE: Record<string, string> = {
  text: '%text',
  thinking: '%thinking',
  tool_use: '%tool_use',
  tool_result: '%tool_result',
  file: '%attach',
  image: '%attach',
  error: '%error',
  custom: '%custom',
}

/**
 * Part → sub-node (a ChatMessage with a `%` role) for writing to nr-chat. The
 * reverse of the §4 dictionary: used by mutations when assembling a new message.
 *
 * Note: `file`/`image` in the protocol carry meta only, there is no extracted
 * text in the DTO — the `%%attach` sub-node body is empty (the sidecar text is
 * added by the backend).
 */
export function partToSubMessage(part: Part): ChatMessage {
  const role = PART_TYPE_TO_ROLE[part.type] ?? '%' + part.type

  switch (part.type) {
    case 'text':
      return { role, body: part.text }

    case 'thinking': {
      const meta = part.meta?.signature !== undefined ? { signature: part.meta.signature } : undefined
      return { role, body: part.text, meta }
    }

    case 'tool_use': {
      const body = typeof part.data === 'string' ? part.data : stringifyJson5(part.data ?? {})
      return { role, body, meta: { callId: part.meta.callId, name: part.meta.name } }
    }

    case 'tool_result': {
      const meta: Record<string, unknown> = { callId: part.meta.callId }
      if (part.meta.name !== undefined) meta.name = part.meta.name
      if (part.meta.error) meta.error = true
      const body = writeTextData(part.text, part.data, meta)
      return { role, body, meta }
    }

    case 'file': {
      const meta: Record<string, unknown> = {}
      if (part.meta.ref) meta.file = part.meta.ref
      if (part.meta.mime) meta.mime = part.meta.mime
      if (part.meta.url) meta.url = part.meta.url
      // Extracted text (§2) is the sub-node body — round-trips with FilePart.text.
      return { role, name: part.meta.name, body: part.text ?? '', meta: Object.keys(meta).length ? meta : undefined }
    }

    case 'image': {
      const meta: Record<string, unknown> = {}
      if (part.meta.ref) meta.file = part.meta.ref
      if (part.meta.mime) meta.mime = part.meta.mime
      if (part.meta.url) meta.url = part.meta.url
      return { role, name: part.meta.alt, body: part.text ?? '', meta: Object.keys(meta).length ? meta : undefined }
    }

    case 'error':
      return { role, body: part.text, meta: part.meta?.code !== undefined ? { code: part.meta.code } : undefined }

    case 'custom': {
      const meta: Record<string, unknown> = { ...part.meta }
      const body = writeTextData(part.text, part.data, meta)
      return { role, body, meta }
    }
  }
}
