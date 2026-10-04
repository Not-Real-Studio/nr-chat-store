/**
 * Персоны (personas-spec §1–2, §4): правила, общие для писателя (pi-расширение),
 * читателя (backend-pi, pi-драйвер) и сборки (`assembleRp`, DEV-224).
 *
 * Здесь — имя записи, проверка формы и правила «имя в модель только текстом»:
 * подстановка `{{char}}`/`{{user}}`, префикс `Имя: ` на отправке, срез префикса
 * с ответа, блок участников для system prompt. Разойтись им нельзя: префикс,
 * который пишет один, обязан срезать другой. Чистые функции, без IO.
 *
 * Дом — сабпат assembly (DEV-224): общая RP-сборка их зовёт, а пакет ниже
 * протокола его импортировать не может. nr-ui-protocol ре-экспортирует всё под
 * теми же именами.
 */

import type { Persona, PersonasDoc } from '../model.js'

/** customType записи с документом персон в сессии pi (§1). Служебная — в ленте её нет. */
export const PERSONAS_CUSTOM_TYPE = 'nr-session-personas'

/** `source` инъекции рецепта, которую добавили персоны (§4). */
export const PERSONA_INJECTION_SOURCE = 'persona'

// ────────────────────────────────────────────────────────────────────────────
// Форма
// ────────────────────────────────────────────────────────────────────────────

const OPTIONAL_STRINGS = ['avatar', 'model', 'prompt', 'color'] as const

/** Форма персоны: обязательные поля нужных типов, необязательные — строки, если есть. */
export function isPersona(v: unknown): v is Persona {
  if (!isRecord(v)) return false
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return false
  if (v.kind !== 'user' && v.kind !== 'char') return false
  return OPTIONAL_STRINGS.every((k) => v[k] === undefined || typeof v[k] === 'string')
}

/** Форма документа персон — строго (все персоны годные). */
export function isPersonasDoc(v: unknown): v is PersonasDoc {
  if (!isRecord(v) || !Array.isArray(v.personas)) return false
  if (v.userId !== undefined && typeof v.userId !== 'string') return false
  return v.personas.every(isPersona)
}

/**
 * Документ из данных записи — терпимо: битые персоны выпадают, `userId`
 * остаётся, только если он строка. Одна кривая персона не должна отнимать у
 * сессии остальных. Не объект — `undefined` (запись пропускается целиком).
 */
export function personasDocOf(data: unknown): PersonasDoc | undefined {
  if (!isRecord(data)) return undefined
  const personas = Array.isArray(data.personas) ? data.personas.filter(isPersona) : []
  const doc: PersonasDoc = { personas }
  if (typeof data.userId === 'string') doc.userId = data.userId
  return doc
}

/**
 * Почему документ нельзя сохранить (`personas.save` → `bad_request`); годится —
 * `undefined`. id и имя непустые, id уникальны, `userId` — существующая
 * `user`-персона.
 */
export function validatePersonas(personas: unknown, userId?: unknown): string | undefined {
  if (!Array.isArray(personas)) return 'personas — не массив'
  const ids = new Set<string>()
  for (const [i, p] of personas.entries()) {
    if (!isPersona(p)) return `персона #${i}: битая форма (id, kind 'user'|'char', name — обязательны)`
    if (p.id.trim() === '') return `персона #${i}: пустой id`
    if (p.name.trim() === '') return `персона ${p.id}: пустое имя`
    if (ids.has(p.id)) return `персона ${p.id}: id повторяется`
    ids.add(p.id)
  }
  if (userId === undefined) return undefined
  if (typeof userId !== 'string') return 'userId — не строка'
  const user = (personas as Persona[]).find((p) => p.id === userId)
  if (!user) return `userId ${userId}: такой персоны нет`
  if (user.kind !== 'user') return `userId ${userId}: персона не user`
  return undefined
}

// ────────────────────────────────────────────────────────────────────────────
// Кто есть кто
// ────────────────────────────────────────────────────────────────────────────

/** `user`-персона сессии: по `userId`, иначе первая `user`. */
export function userPersona(doc: PersonasDoc): Persona | undefined {
  const byId = doc.userId === undefined ? undefined : doc.personas.find((p) => p.id === doc.userId && p.kind === 'user')
  return byId ?? doc.personas.find((p) => p.kind === 'user')
}

/** Собеседники в порядке документа. */
export function charPersonas(doc: PersonasDoc): Persona[] {
  return doc.personas.filter((p) => p.kind === 'char')
}

/**
 * Чей ход (§3). Явный `personaId` — эта `char`-персона (нет такой — `undefined`:
 * что делать с чужим id, решает бэкенд). Без него — активная `char`-персона
 * сессии: первая в документе (порядок задаёт тот, кто документ пишет).
 */
export function turnPersona(doc: PersonasDoc, personaId?: string): Persona | undefined {
  const chars = charPersonas(doc)
  if (personaId === undefined) return chars[0]
  return chars.find((p) => p.id === personaId)
}

/**
 * Нужны ли имена в тексте (§2): собеседников больше одного либо у персоны хода
 * есть `prompt`. Один собеседник и один пользователь — обычный чат, без шума.
 */
export function personasVoiced(doc: PersonasDoc, turn: Persona | undefined): boolean {
  return charPersonas(doc).length > 1 || (turn?.prompt?.trim() ?? '') !== ''
}

// ────────────────────────────────────────────────────────────────────────────
// Имя в тексте (§2)
// ────────────────────────────────────────────────────────────────────────────

/**
 * `{{char}}` (и ST-шный `<BOT>`) → имя собеседника, `{{user}}` (`<USER>`) → имя
 * пользователя; регистр не важен. Имени нет — плейсхолдер остаётся: модель
 * увидит его, а не пустоту.
 */
export function expandPersonaNames(text: string, names: { char?: string | undefined; user?: string | undefined }): string {
  let out = text
  if (names.char !== undefined) out = out.replace(/\{\{char\}\}|<bot>/gi, names.char)
  if (names.user !== undefined) out = out.replace(/\{\{user\}\}|<user>/gi, names.user)
  return out
}

/** Префикс имени на отправке: `Имя: текст`. */
export function personaPrefixed(name: string, text: string): string {
  return `${name}: ${text}`
}

/**
 * Реплика ответа без префикса `Имя:` известной персоны (§2) — и чья она.
 *
 * Сравнение без учёта регистра, длинные имена первыми («Анна Мария» раньше
 * «Анна»); понимает и markdown-жирное `**Имя:**` / `**Имя**:`. Незнакомое имя
 * не трогается: `Примечание: …` — это текст, а не реплика.
 */
export function stripPersonaPrefix(text: string, personas: readonly Persona[]): { text: string; personaId?: string } {
  const lead = text.length - text.trimStart().length
  const body = text.slice(lead)
  const lower = body.toLowerCase()
  const byLength = [...personas].filter((p) => p.name.trim() !== '').sort((a, b) => b.name.length - a.name.length)
  for (const persona of byLength) {
    const name = persona.name.trim().toLowerCase()
    for (const prefix of [`${name}:`, `**${name}:**`, `**${name}**:`]) {
      if (lower.startsWith(prefix)) return { text: body.slice(prefix.length).trimStart(), personaId: persona.id }
    }
  }
  return { text }
}

/**
 * Блок участников для system prompt (§4), когда имена в ходу: кто в диалоге,
 * чей ход и `prompt` персоны хода. Плейсхолдеры в `prompt` раскрыты.
 */
export function personasSystemBlock(doc: PersonasDoc, turn: Persona | undefined): string {
  const user = userPersona(doc)
  const lines = ['В этом диалоге участвуют:']
  for (const p of charPersonas(doc)) lines.push(`- ${p.name}`)
  if (user) lines.push(`- ${user.name} (пользователь)`)
  if (turn) {
    lines.push('', `Сейчас ход: ${turn.name}. Отвечай только за ${turn.name}.`)
    const prompt = turn.prompt?.trim()
    if (prompt) lines.push('', expandPersonaNames(prompt, { char: turn.name, user: user?.name }))
  }
  return lines.join('\n')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
