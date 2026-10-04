/**
 * RP-сборка (backend-nr-spec §5) — ОДНА на оба бэкенда: `ContextEngine.assemble`
 * backend-nr и хуки pi-ext-session-meta (`before_agent_start` → system,
 * `context` → сообщения) зовут эту функцию (DEV-222 — перенос из pi-ext,
 * DEV-224 — сюда из backend-nr, pi-ext стал адаптером).
 *
 * Вход — видимое модели после компакции (DTO протокола), мета, персоны,
 * профиль, адресат хода. Выход — system по блокам, сообщения для провайдера
 * (DTO; синтетические — с id `nr:…`), рецепт (инъекции с источниками и
 * причинами). Без IO: книги профиля приходят готовыми (`lore-files`).
 *
 * Шаги (порядок story string ST):
 *  1. имена рана: `{{char}}` — персона хода, `{{user}}` — персона игрока
 *     (нет — `persona.user` меты);
 *  2. лорбук ×3 (бот — `meta.lorebook`, персона — `lorebook` user-персоны,
 *     профиль — `$lorebook`) общим пулом и бюджетом, скан истории + карточки;
 *  3. system: лор до · `pre` · лор после · `<User>'s Persona` · (штатный по
 *     режиму) · блок участников, если имена в ходу;
 *  4. история: имена `Имя: ` по персонам (если в ходу), маркер «продолжай»
 *     (ход без реплики), `post` после истории, подсказка хода `\nИмя: ` в
 *     конце, character's note и записи лорбука «на глубине»;
 *  5. impersonate (`target: {kind: 'user'}`): тот же system и история без
 *     post/заметок, в конце — инструкция шаблона `$impersonate` с макросами;
 *     тайные поля персоны (`scenario`, `system_prompt`,
 *     `post_history_instructions`) — только здесь.
 */

import type { Message as DtoMessage, Part, Persona, PersonasDoc, ProfileDoc } from '../model.js'
import { compactionData } from './engine.js'
import { loreSourceLabel, lorebookOf, selectLore, type LoreSelection, type LoreSource, type Lorebook } from './lorebook.js'
import {
  PERSONA_INJECTION_SOURCE,
  charPersonas,
  expandPersonaNames,
  personaPrefixed,
  personasSystemBlock,
  personasVoiced,
  turnPersona,
  userPersona,
} from './personas.js'
import { CONTINUE_TEXT, impersonatePrompt, injectAtDepth, storyString, type SystemBlock } from './rp.js'

/**
 * Мета сессии, как её читает сборка (`SessionMetaDoc` протокола структурно):
 * пакет ниже протокола, тип здесь — только нужные поля.
 */
export interface RpSessionMeta {
  prompt?: { mode?: unknown; pre?: unknown; post?: unknown }
  lorebook?: unknown
  depthPrompt?: unknown
  persona?: unknown
  [key: string]: unknown
}

/** Источник инъекции character's note — как у pi-ext. */
export const DEPTH_PROMPT_SOURCE = 'depth_prompt'
/** Источник инструкции impersonate в рецепте. */
export const IMPERSONATE_SOURCE = 'impersonate'
/** Источник маркера «продолжай» в рецепте. */
export const CONTINUE_SOURCE = 'continue'
/** Префикс id синтетических сообщений сборки (в ленте их нет). */
export const SYNTHETIC_ID_PREFIX = 'nr:'

/** Лорбук профиля рана (`$lorebook*`): книги уже прочитаны. */
export interface ProfileLore {
  books: Lorebook[]
  budget?: number
  scanCard: boolean
}

export interface RpInput {
  /** Видимое модели после компакции (узел компакции — первым, если есть). */
  messages: DtoMessage[]
  meta: RpSessionMeta
  personas?: PersonasDoc
  /** Персона хода (`char`); нет — первая `char`. */
  persona?: Persona
  /** Профиль рана: режим промпта по умолчанию и шаблон impersonate. */
  profile?: Pick<ProfileDoc, 'prompt' | 'impersonate'>
  /** Штатный system: профиль, каталог скиллов — блоками. */
  base: SystemBlock[]
  profileLore?: ProfileLore
  /** Impersonate: игрок отвечает. */
  impersonate?: boolean
  /** `{{input}}` impersonate. */
  input?: string
}

export interface RpInjection {
  role: 'system' | 'user' | 'assistant'
  text: string
  source: string
  reason?: string
}

export interface RpAssembled {
  system: string
  systemBlocks: SystemBlock[]
  messages: DtoMessage[]
  injections: RpInjection[]
  /** id сообщений стора, ушедших в контекст (без синтетических). */
  messageIds: string[]
  /** Отбор лорбука (для диагностики/тестов). */
  lore?: LoreSelection
}

/** Есть ли у сессии RP-слой: мета с промптом/лорбуком/заметкой, персоны, лорбук профиля. */
export function hasRpLayer(meta: RpSessionMeta | undefined, personas: PersonasDoc | undefined, lore: ProfileLore | undefined): boolean {
  if (personas?.personas.length) return true
  if (lore?.books.length) return true
  if (!meta) return false
  return Boolean(nonEmpty(meta.prompt?.pre) || nonEmpty(meta.prompt?.post) || meta.lorebook || meta.depthPrompt || personaUserOf(meta))
}

export function assembleRp(input: RpInput): RpAssembled {
  const meta = input.meta
  const doc: PersonasDoc = input.personas ?? { personas: [] }
  const hasCast = doc.personas.length > 0
  const turn = input.persona ?? (hasCast ? turnPersona(doc) : undefined)
  const user = hasCast ? userPersona(doc) : undefined
  const voiced = hasCast && personasVoiced(doc, turn)
  const names = { char: turn?.name ?? (hasCast ? charPersonas(doc)[0]?.name : undefined), user: user?.name ?? personaUserOf(meta) }
  const expand = (text: string) => expandPersonaNames(text, names)

  // ── лорбук ×3 ──────────────────────────────────────────────────────────────
  const userRec = user as (Persona & Record<string, unknown>) | undefined
  const sources: LoreSource[] = []
  const botBook = lorebookOf(meta.lorebook)
  if (botBook) sources.push({ kind: 'bot', book: botBook })
  const personaBook = lorebookOf(userRec?.lorebook)
  if (personaBook) sources.push({ kind: 'persona', book: personaBook })
  for (const book of input.profileLore?.books ?? []) sources.push({ kind: 'profile', book })
  const pre = nonEmpty(meta.prompt?.pre)
  // Карточка для скана: pre и ОТКРЫТЫЕ поля персоны. scenario — тайное: ключ
  // по нему выдал бы его боту через сработавшую запись.
  const cardText = [pre, str(userRec?.description), str(userRec?.personality)]
    .filter((t): t is string => t !== undefined && t.trim() !== '')
    .map(expand)
    .join('\n')
  const history = input.messages.filter((m) => !compactionData(m))
  const lore = sources.length
    ? selectLore(sources, history.filter((m) => m.role === 'user' || m.role === 'assistant').map(textOf).filter((t) => t.trim() !== ''), {
        expand,
        scanCard: input.profileLore?.scanCard === true,
        cardText,
        depthPositions: true,
        priority: true,
        ...(input.profileLore?.budget !== undefined ? { budget: input.profileLore.budget } : {}),
      })
    : undefined

  // ── system: story string ───────────────────────────────────────────────────
  const description = str(userRec?.description)
  const personaBlock = names.user && description?.trim() ? `${names.user}'s Persona: ${expand(description).trim()}` : undefined
  const metaMode = meta.prompt?.mode
  const mode = metaMode !== undefined ? (metaMode === 'replace' ? 'replace' : 'append') : (input.profile?.prompt?.mode ?? 'append')
  const story = storyString(
    {
      before: (lore?.before ?? []).map((e) => ({ source: loreSourceLabel(e.source, e.name), text: e.content })),
      ...(pre !== undefined ? { pre: expand(pre) } : {}),
      after: (lore?.after ?? []).map((e) => ({ source: loreSourceLabel(e.source, e.name), text: e.content })),
      ...(personaBlock ? { persona: personaBlock } : {}),
    },
    input.base,
    mode,
  )
  const castBlock = voiced ? personasSystemBlock(doc, turn) : undefined
  const systemBlocks = castBlock ? [...story.blocks, { source: PERSONA_INJECTION_SOURCE, text: castBlock }] : story.blocks
  const system = systemBlocks.map((b) => b.text).join('\n\n')

  // ── рецепт: инъекции в порядке pi-ext ──────────────────────────────────────
  const injections: RpInjection[] = []
  for (const e of [...(lore?.before ?? []), ...(lore?.after ?? [])]) injections.push({ role: 'system', text: e.content, source: loreSourceLabel(e.source, e.name), reason: e.reason })
  if (lore?.dropped.length) {
    injections.push({
      role: 'system',
      text: `не вошли (бюджет ${lore.budget}): ${lore.droppedEntries.map((d) => `${d.label} (≈${d.tokens} tok)`).join(', ')}`,
      source: `lorebook: отброшено ${lore.dropped.length} записей (бюджет)`,
      reason: 'бюджет',
    })
  }
  if (personaBlock) injections.push({ role: 'system', text: personaBlock, source: 'persona.user' })
  if (castBlock) injections.push({ role: 'system', text: castBlock, source: PERSONA_INJECTION_SOURCE })

  // ── история ────────────────────────────────────────────────────────────────
  const speakerOf = speakers(doc, turn, user)
  const byId = new Map(doc.personas.map((p) => [p.id, p]))
  let out: DtoMessage[] = input.messages.map((m) => {
    if (!voiced || compactionData(m) || (m.role !== 'user' && m.role !== 'assistant')) return m
    const persona = byId.get(speakerOf(m) ?? '')
    return persona ? withText(m, (t) => personaPrefixed(persona.name, t), 'first') : m
  })
  const messageIds = input.messages.map((m) => m.id)

  if (input.impersonate) {
    // Impersonate: история как есть (без post и заметок), инструкция — последней.
    const instruction = impersonatePrompt(input.profile?.impersonate, {
      user: names.user ?? 'User',
      char: names.char ?? 'Character',
      input: input.input ?? '',
      persona: {
        ...(str(userRec?.description) ? { description: str(userRec?.description)! } : {}),
        ...(str(userRec?.scenario) ? { scenario: str(userRec?.scenario)! } : {}),
        ...(str(userRec?.system_prompt) ? { system_prompt: str(userRec?.system_prompt)! } : {}),
        ...(str(userRec?.post_history_instructions) ? { post_history_instructions: str(userRec?.post_history_instructions)! } : {}),
      },
    })
    out.push(synthetic('impersonate', 'user', instruction))
    injections.push({ role: 'user', text: instruction, source: IMPERSONATE_SOURCE })
    return { system, systemBlocks, messages: out, injections, messageIds, ...(lore ? { lore } : {}) }
  }

  // Ход без реплики (`run.continue`): история кончается ответом — маркер.
  const last = history.at(-1)
  const continuing = last !== undefined && last.role === 'assistant'
  let marker: DtoMessage | undefined
  if (continuing) {
    marker = synthetic('continue', 'user', CONTINUE_TEXT)
    out.push(marker)
  }
  const post = nonEmpty(meta.prompt?.post)
  // Порядок инъекций рецепта — как у pi-ext: заметка и глубина раньше post.
  const tail: RpInjection[] = []
  if (post !== undefined) {
    const text = expand(post)
    out.push(synthetic('post', 'user', text))
    tail.push({ role: 'user', text, source: 'meta.post' })
  }
  // Подсказка хода (§2): `\nИмя: ` к последнему user — модель видит, чья реплика.
  if (voiced && turn && out.length && out[out.length - 1]!.role === 'user') {
    out[out.length - 1] = withText(out[out.length - 1]!, (t) => `${t}\n${turn.name}: `, 'last')
  }
  // Маркер при именах — подсказкой хода `Имя:` (continue.ts pi-ext).
  if (marker) {
    const at = out.indexOf(out.find((m) => m.id === marker!.id)!)
    const text = voiced && turn ? `${turn.name}:` : textOf(out[at]!)
    out[at] = { ...out[at]!, parts: [{ type: 'text', text }] }
    tail.push({ role: 'user', text, source: CONTINUE_SOURCE })
  }

  // Character's note и записи «на глубине» — от конца, user-сообщением (роль — в рецепте).
  const depth: Array<{ depth: number; message: DtoMessage }> = []
  const note = depthPromptOf(meta)
  if (note) {
    const text = expand(note.prompt)
    depth.push({ depth: note.depth, message: synthetic('depth', 'user', text) })
    injections.push({ role: note.role, text, source: DEPTH_PROMPT_SOURCE })
  }
  for (const e of lore?.depth ?? []) {
    depth.push({ depth: e.depth ?? 4, message: synthetic(`lore-${depth.length}`, 'user', e.content) })
    injections.push({ role: e.role ?? 'system', text: e.content, source: `${loreSourceLabel(e.source, e.name)} @${e.depth ?? 4}`, reason: e.reason })
  }
  out = injectAtDepth(out, depth)
  injections.push(...tail)
  return { system, systemBlocks, messages: out, injections, messageIds, ...(lore ? { lore } : {}) }
}

// ────────────────────────────────────────────────────────────────────────────

/** Character's note меты (`depthPrompt`), как `depthPromptOf` pi-ext. */
export function depthPromptOf(meta: RpSessionMeta): { prompt: string; depth: number; role: 'system' | 'user' | 'assistant' } | undefined {
  const v = meta.depthPrompt as Record<string, unknown> | undefined
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const prompt = nonEmpty(v.prompt)
  if (prompt === undefined) return undefined
  const depth = typeof v.depth === 'number' && Number.isFinite(v.depth) && v.depth >= 0 ? Math.floor(v.depth) : 4
  const role = v.role === 'user' || v.role === 'assistant' ? v.role : 'system'
  return { prompt, depth, role }
}

/**
 * Кто сказал сообщение (правило pi-ext `speakersOf` / backend-pi): `meta.personaId`
 * (pi-драйвер берёт его из рецепта); user без него — игрок; ответ без него —
 * первая `char` (гритинги импорта, раны до персон).
 */
function speakers(doc: PersonasDoc, turn: Persona | undefined, user: Persona | undefined): (m: DtoMessage) => string | undefined {
  const first = charPersonas(doc)[0]?.id ?? turn?.id
  return (m) => {
    const id = m.meta?.personaId
    if (typeof id === 'string') return id
    if (m.role === 'user') return user?.id
    if (m.role === 'assistant') return first
    return undefined
  }
}

function personaUserOf(meta: RpSessionMeta): string | undefined {
  const p = meta.persona as { user?: unknown } | undefined
  return p && typeof p === 'object' && typeof p.user === 'string' && p.user.trim() ? p.user.trim() : undefined
}

function synthetic(name: string, role: string, text: string): DtoMessage {
  return { id: `${SYNTHETIC_ID_PREFIX}${name}`, role, parts: [{ type: 'text', text }] }
}

/** Текст сообщения для модели: text-части через перенос. */
export function textOf(m: Pick<DtoMessage, 'parts'>): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text?: string }).text ?? '')
    .join('\n')
}

/** Копия сообщения с правкой первой/последней text-части; нет её — добавить. */
function withText(m: DtoMessage, edit: (t: string) => string, which: 'first' | 'last'): DtoMessage {
  const idx = m.parts.map((p, i) => (p.type === 'text' ? i : -1)).filter((i) => i >= 0)
  const at = which === 'first' ? idx[0] : idx[idx.length - 1]
  if (at === undefined) {
    const part: Part = { type: 'text', text: edit('') }
    return { ...m, parts: which === 'first' ? [part, ...m.parts] : [...m.parts, part] }
  }
  return { ...m, parts: m.parts.map((p, i) => (i === at && p.type === 'text' ? { ...p, text: edit(p.text) } : p)) }
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}
