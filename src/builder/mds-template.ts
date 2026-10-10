/**
 * Билдер `mds-template` (session-document-spec §4.3): шаблон агента `.mds` ×
 * документ сессии → узлы промпта, рецепт и `.mds` выхода.
 *
 *  1. Шаблон разбирается кодеком nr-chat (`%role name {meta}` — тот же формат,
 *     что под pi-session-mds): `%system`/`%user`/`%assistant` — узлы, слова
 *     имени `prefill`/`hidden` и мета `{source, prefill, hidden}` — пометки,
 *     `%include <файл>` — узлы файла как есть, `%meta {…}` — мета выхода.
 *  2. Тело узла — ntpl (`nrd/template`: `<{ }>`, `<< >>`, `<# #>`; `{{…}}`
 *     сквозь) с контекстом §4.4, фильтрами и тегами §4.5 (`tags.ts`).
 *  3. История — путь сессии с именами по персонам и маркером «продолжай»;
 *     вставки `inject` — на глубине от конца ленты (история и узлы после неё,
 *     без префила) — как `assembleRp`.
 *  4. Макросы `{{user}}`/`{{char}}` раскрываются на итоговом тексте узлов
 *     шаблона и в тексте истории (гритинг хранит `{{user}}`, DEV-256).
 *
 * Семантика RP-кусков — те же хелперы, что у `assembleRp` (лорбук ×3, блок
 * персоны, блок участников, impersonate, вставка на глубине): `rp.mds` обязан
 * давать тот же system и те же инъекции (паритет — тест backend-nr).
 */

import { parse, stringify, type ChatMessage } from '@notrealstudio/nr-chat'
import { createEnv } from '@notrealstudio/nrd/template'
import type { Message as DtoMessage, Part, Persona, PersonasDoc } from '../model.js'
import { compactionData } from '../assembly/engine.js'
import { loreSourceLabel, lorebookOf, selectLore, type LoreSelection, type LoreSource } from '../assembly/lorebook.js'
import {
  PERSONA_INJECTION_SOURCE,
  charPersonas,
  expandMessageNames,
  expandPersonaNames,
  expandPlayerNames,
  personaPrefixed,
  personasSystemBlock,
  personasVoiced,
  turnPersona,
  userPersona,
} from '../assembly/personas.js'
import { CONTINUE_TEXT, impersonatePrompt, injectAtDepth, type SystemBlock } from '../assembly/rp.js'
import { CONTINUE_SOURCE, IMPERSONATE_SOURCE, SYNTHETIC_ID_PREFIX, textOf, type RpInjection } from '../assembly/assemble-rp.js'
import type { BuildInput, BuildOutput, BuildRecipe, PromptBuilder, PromptNode } from './contract.js'
import { mark, parseRendered, preprocess, registerTags, splitLeadingSources, stripMarks, type InjectSpec } from './tags.js'

export const MDS_TEMPLATE_BUILDER = 'mds-template'

/** Поля карты, из которых собирается текст карточки для скана лорбука (порядок story string). */
const CARD_SCAN_FIELDS = ['system_prompt', 'description', 'personality', 'scenario', 'mes_example'] as const

/** Тайные поля user-персоны (personas-spec §9) — видит только impersonate. */
const USER_SECRET_FIELDS = ['scenario', 'system_prompt', 'post_history_instructions'] as const

export const mdsTemplateBuilder: PromptBuilder = {
  name: MDS_TEMPLATE_BUILDER,
  build: buildMdsTemplate,
}

// ────────────────────────────────────────────────────────────────────────────

interface TemplateNode {
  role: string
  body: string
  source?: string
  prefill: boolean
  hidden: boolean
  /** Узел из `%include` — не рендерится. */
  raw?: boolean
}

/** Шаблон → записи (узлы, include, meta). Ошибки — текстом с путём шаблона. */
export function parseTemplate(text: string, where = 'шаблон'): { nodes: TemplateNode[]; includes: string[]; meta: Record<string, unknown>; records: ChatMessage[] } {
  const records = parse(text)
  if (!records.length) throw new Error(`${where}: шаблон агента пуст (нет ни одного %-узла)`)
  const includes: string[] = []
  const nodes: TemplateNode[] = []
  let meta: Record<string, unknown> = {}
  for (const r of records) {
    if (r.role === 'meta') {
      meta = { ...meta, ...(r.meta ?? {}) }
      continue
    }
    if (r.role === 'include') {
      const path = (r.name ?? '').trim()
      if (!path) throw new Error(`${where}: %include без файла`)
      includes.push(path)
      continue
    }
    nodes.push(templateNode(r))
  }
  return { nodes, includes, meta, records }
}

function templateNode(r: ChatMessage, raw = false): TemplateNode {
  const words = new Set((r.name ?? '').split(/\s+/).filter(Boolean))
  const m = r.meta ?? {}
  const node: TemplateNode = {
    role: r.role,
    body: r.body,
    prefill: words.has('prefill') || m.prefill === true,
    hidden: words.has('hidden') || m.hidden === true,
  }
  if (typeof m.source === 'string' && m.source !== '') node.source = m.source
  if (raw) node.raw = true
  return node
}

// ────────────────────────────────────────────────────────────────────────────
// Документ → контекст шаблона
// ────────────────────────────────────────────────────────────────────────────

interface DocView {
  doc: PersonasDoc
  turn: Persona | undefined
  user: Persona | undefined
  voiced: boolean
  names: { char?: string; user?: string }
  card: Record<string, unknown>
  userCard: Record<string, unknown>
  lore: LoreSelection | undefined
  expand: (text: string) => string
  /** Поля персоны игрока: `{{user}}` и `{{char}}` — оба она (DECISIONS 09.10). */
  expandPlayer: (text: string) => string
}

function viewOf(input: BuildInput): DocView {
  const { document: d } = input
  const doc: PersonasDoc = { personas: d.personas, ...(d.userId !== undefined ? { userId: d.userId } : {}) }
  const hasCast = doc.personas.length > 0
  const turn = hasCast ? turnPersona(doc, input.turn?.target) ?? turnPersona(doc) : undefined
  const user = hasCast ? userPersona(doc) : undefined
  const voiced = hasCast && personasVoiced(doc, turn)
  const names = {
    ...(turn?.name ?? charPersonas(doc)[0]?.name ? { char: (turn?.name ?? charPersonas(doc)[0]?.name)! } : {}),
    ...(user?.name ?? personaUserOf(d.meta) ? { user: (user?.name ?? personaUserOf(d.meta))! } : {}),
  }
  const expand = (text: string) => expandPersonaNames(text, names)
  const expandPlayer = (text: string) => expandPlayerNames(text, names.user)
  const card = isRecord(turn?.card) ? turn!.card : {}
  const userCard = userCardOf(user)

  // Лорбук ×3 (бот — мета и карта, персона, профиль): как assembleRp.
  const sources: LoreSource[] = []
  const metaBook = lorebookOf(d.meta.lorebook)
  if (metaBook) sources.push({ kind: 'bot', book: metaBook })
  const cardBook = lorebookOf(card.character_book)
  if (cardBook) sources.push({ kind: 'bot', book: cardBook })
  const personaBook = lorebookOf(userCard.character_book ?? (user as Record<string, unknown> | undefined)?.lorebook)
  if (personaBook) sources.push({ kind: 'persona', book: personaBook })
  for (const book of input.profileLore?.books ?? []) sources.push({ kind: 'profile', book })
  // Карточка для скана: override меты или текст карты, и ОТКРЫТЫЕ поля персоны.
  const botText = nonEmpty(promptOf(d.meta).pre) ?? cardStory(card)
  const cardText = [botText === undefined ? undefined : expand(botText), ...[str(userCard.description), str(userCard.personality)].map((t) => (t === undefined ? t : expandPlayer(t)))]
    .filter((t): t is string => t !== undefined && t.trim() !== '')
    .join('\n')
  const history = d.path.filter((m) => !compactionData(m))
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
  return { doc, turn, user, voiced, names, card, userCard, lore, expand, expandPlayer }
}

/** Текст карты, как его раскладывал `card-pre.ntpl` импорта: для скана лорбука. */
function cardStory(card: Record<string, unknown>): string | undefined {
  const parts: string[] = []
  for (const k of CARD_SCAN_FIELDS) {
    const v = str(card[k])
    if (v && v.trim()) parts.push(v.trim())
  }
  return parts.length ? parts.join('\n\n') : undefined
}

/** Поля user-персоны: плоские (старые записи) под картой (новые). */
function userCardOf(user: Persona | undefined): Record<string, unknown> {
  if (!user) return {}
  const flat = user as unknown as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of ['description', 'personality', ...USER_SECRET_FIELDS]) if (typeof flat[k] === 'string') out[k] = flat[k]
  return { ...out, ...(isRecord(user.card) ? user.card : {}) }
}

/**
 * Главный промпт impersonate по умолчанию (DEV-243): модель пишет за игрока —
 * GM-инструкции агента и карты бота («не пиши за {{user}}») сюда не идут.
 */
export const DEFAULT_IMPERSONATE_PRE =
  "You are writing as {{user}}, the player's character, in an ongoing roleplay with {{char}}. Stay in {{user}}'s voice and knowledge; do not narrate for {{char}}."

/**
 * Поля персоны игрока для шаблона (`player.<поле>`, DEV-243): текст с
 * источником `persona.<поле>`, `{{user}}` и `{{char}}` — оба имя персоны
 * (DECISIONS 09.10); пусто — поля нет (`default` шаблона срабатывает). Плоские
 * поля под картой персоны (карта сильнее) — как `userCardOf`.
 */
function playerOf(v: DocView): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['description', 'personality', ...USER_SECRET_FIELDS]) {
    const text = nonEmpty(str(v.userCard[k]))
    if (text !== undefined && text.trim() !== '') out[k] = mark.source(`persona.${k}`) + v.expandPlayer(text).trim()
  }
  return out
}

/** Строка с источниками блоков: каждый кусок со своим `S:`-маркером, через пустую строку. */
function sourced(blocks: ReadonlyArray<{ source: string; text: string }>): string {
  return blocks
    .filter((b) => b.text.trim() !== '')
    .map((b) => mark.source(b.source) + b.text)
    .join('\n\n')
}

/** Строка с полями (`base.skills`): `<< base >>` печатает строку, поля — для выборочной вставки. */
function stringWith(text: string, fields: Record<string, string>): string {
  // eslint-disable-next-line no-new-wrappers
  return Object.assign(new String(text), fields) as unknown as string
}

function contextOf(input: BuildInput, v: DocView): Record<string, unknown> {
  const { document: d, agent } = input
  const lore = v.lore
  const fired = (list: LoreSelection['before']) => sourced(list.map((e) => ({ source: loreSourceLabel(e.source, e.name), text: e.content })))
  const description = str(v.userCard.description)
  const personaText = v.names.user && description?.trim() ? `${v.names.user}'s Persona: ${v.expandPlayer(description).trim()}` : ''
  const cast = v.voiced ? personasSystemBlock(v.doc, v.turn) : ''
  const skills = input.base.filter((b) => b.source === 'skills')
  const services = input.base.filter((b) => b.source !== 'skills')
  return {
    agent: {
      ...(agent.extra ?? {}),
      id: agent.id,
      name: agent.name,
      pre: agentPre(agent),
      post: agent.prompt?.post ?? '',
      // Главный промпт impersonate без своего у персоны (DEV-243): нейтральный,
      // без GM-инструкций бота; профиль перекрывает `$impersonate_pre`.
      impersonate_pre: mark.source('agent.impersonate_pre') + (nonEmpty(str(agent.extra?.impersonate_pre)) ?? DEFAULT_IMPERSONATE_PRE),
    },
    player: playerOf(v),
    card: v.card,
    char: v.names.char ?? '',
    user: v.names.user ?? '',
    persona: personaText ? mark.source('persona.user') + personaText : '',
    personas: v.doc.personas,
    cast: cast ? mark.source(PERSONA_INJECTION_SOURCE) + cast : '',
    greeting: d.greeting,
    lore: {
      before: lore ? fired(lore.before) : '',
      after: lore ? fired(lore.after) : '',
      depth: (lore?.depth ?? []).map((e) => ({
        content: e.content,
        depth: e.depth ?? 4,
        role: e.role ?? 'system',
        source: `${loreSourceLabel(e.source, e.name)} @${e.depth ?? 4}`,
        reason: e.reason,
      })),
      dropped: lore?.droppedEntries ?? [],
    },
    base: stringWith(sourced(input.base), { skills: sourced(skills), services: sourced(services) }),
    meta: d.meta,
    turn: { impersonate: input.turn?.impersonate === true, continue: input.turn?.continue === true, input: input.turn?.input ?? '' },
    model: input.model,
  }
}

/** Словарь шаблона агента (DEV-262, подсказка конструктора): что шаблон видит. */
export interface TemplateVocabulary {
  /** Переменные контекста: `agent`, `agent.pre`, `player.description`, `lore.before`… */
  variables: string[]
  /** Фильтры ntpl: `card`, `post`, `greeting`, `label`, `macros`. */
  filters: string[]
  /** Теги: `history`, `inject`, `impersonate`. */
  tags: string[]
  /** Макросы текста на выходе. */
  macros: string[]
}

/**
 * Словарь шаблона — из самого билдера, не списком руками (DEV-262): контекст и
 * фильтры строятся на пустом документе с полной персоной игрока, теги — у
 * расширений ntpl. Новая переменная `contextOf` появится в подсказке сама.
 */
export async function templateVocabulary(): Promise<TemplateVocabulary> {
  const full = Object.fromEntries(['description', 'personality', ...USER_SECRET_FIELDS].map((k) => [k, 'x']))
  const input: BuildInput = {
    session: { id: 'vocabulary' },
    document: { path: [], meta: {}, personas: [{ id: 'c', kind: 'char', name: 'C' }, { id: 'u', kind: 'user', name: 'U', card: full } as Persona], userId: 'u' },
    agent: { id: 'a', name: 'A', template: '', includes: {}, templatePath: 'vocabulary' },
    model: { id: 'm' },
    base: [],
    tools: [],
  }
  const v = viewOf(input)
  const ctx = contextOf(input, v)
  const variables: string[] = []
  for (const [k, val] of Object.entries(ctx)) {
    variables.push(k)
    if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof String)) for (const sub of Object.keys(val)) variables.push(`${k}.${sub}`)
  }
  for (const sub of ['skills', 'services']) variables.push(`base.${sub}`)
  const env = await createEnv()
  registerTags(env)
  const tags = ((env as unknown as { extensionsList?: Array<{ tags?: string[] }> }).extensionsList ?? []).flatMap((e) => e.tags ?? [])
  return { variables, filters: Object.keys(filtersOf(input, v)), tags, macros: ['{{user}}', '{{char}}', '{{original}}'] }
}

/** `agent.pre`: `$prompt.pre`, иначе тело профиля (`systemPrompt`) — один источник, два способа записать. */
export function agentPre(agent: { prompt?: { pre?: string }; systemPrompt?: string }): string {
  return nonEmpty(agent.prompt?.pre) ?? agent.systemPrompt ?? ''
}

// ────────────────────────────────────────────────────────────────────────────
// Фильтры (§4.4)
// ────────────────────────────────────────────────────────────────────────────

function filtersOf(input: BuildInput, v: DocView) {
  const meta = promptOf(input.document.meta)
  return {
    /** Главный промпт: `meta.prompt.pre` → `card.system_prompt` (`{{original}}` = вход) → вход. */
    card(value: unknown): string {
      const original = strOf(value)
      const override = nonEmpty(meta.pre)
      if (override !== undefined) return mark.source('meta.prompt.pre') + override
      const sp = nonEmpty(str(v.card.system_prompt))
      if (sp !== undefined) return mark.source('card.system_prompt') + replaceOriginal(sp, stripMarks(original))
      return original
    },
    /** Хвост: `meta.prompt.post` → `card.post_history_instructions` (`{{original}}`) → вход. */
    post(value: unknown): string {
      const original = strOf(value)
      const override = nonEmpty(meta.post)
      if (override !== undefined) return mark.source('meta.prompt.post') + override
      const ph = nonEmpty(str(v.card.post_history_instructions))
      if (ph !== undefined) return mark.source('card.post_history_instructions') + replaceOriginal(ph, stripMarks(original))
      return original
    },
    /** Поле из данных выбранного гритинга (`greeting.data.<поле>`, по умолчанию `scenario`), иначе вход. */
    greeting(value: unknown, field = 'scenario'): string {
      const g = input.document.greeting
      const data = g && isRecord(g.data) ? g.data : undefined
      const own = data ? nonEmpty(str(data[field])) : undefined
      if (own !== undefined && g) return mark.source(`greeting[${g.index}].${field}`) + own
      // Своих данных у гритинга нет — текст карты, подпись с номером выбранного.
      const text = strOf(value)
      if (g && stripMarks(text).trim() !== '') {
        const { head, rest } = splitLeadingSources(text)
        return (head || mark.source(`card.${field} @greeting[${g.index}]`)) + rest
      }
      return text
    },
    /** Подпись блока: `label('Personality')` → `Personality: текст`; пусто — пусто. */
    label(value: unknown, name: unknown, sep: unknown = ': '): string {
      const text = strOf(value)
      if (stripMarks(text).trim() === '') return ''
      const { head, rest } = splitLeadingSources(text)
      return `${head}${String(name)}${String(sep)}${rest}`
    },
    /** Явное раскрытие `{{user}}`/`{{char}}` (по умолчанию и так на выходе). */
    macros(value: unknown): string {
      return v.expand(strOf(value))
    },
  }
}

function replaceOriginal(text: string, original: string): string {
  return text.replace(/\{\{\s*original\s*\}\}/gi, () => original)
}

// ────────────────────────────────────────────────────────────────────────────
// Сборка
// ────────────────────────────────────────────────────────────────────────────

type Piece =
  | { kind: 'node'; node: PromptNode; blocks: SystemBlock[]; template: TemplateNode }
  | { kind: 'history'; injects: InjectSpec[] }
  | { kind: 'impersonate' }

export async function buildMdsTemplate(input: BuildInput): Promise<BuildOutput> {
  const where = `агент ${input.agent.id || '?'} (${input.agent.templatePath ?? 'шаблон'})`
  const tpl = parseTemplate(input.agent.template, where)
  const v = viewOf(input)
  const filters = filtersOf(input, v)
  const env = await createEnv({
    helpers: [
      (e) => {
        registerTags(e)
        for (const [name, fn] of Object.entries(filters)) e.addFilter(name, fn as (...a: unknown[]) => unknown)
      },
    ],
  })
  const ctx = contextOf(input, v)

  // Узлы шаблона и include → куски (рендер тел).
  const nodes: TemplateNode[] = []
  for (const r of tpl.records) {
    if (r.role === 'meta') continue
    if (r.role === 'include') {
      const path = (r.name ?? '').trim()
      const text = input.agent.includes[path]
      if (text === undefined) throw new Error(`${where}: %include ${path} — файл не прочитан платформой`)
      for (const ir of parse(text)) {
        if (ir.role === 'meta' || ir.role === 'include') continue
        const n = templateNode(ir, true)
        n.source ??= `include:${path}`
        nodes.push(n)
      }
      continue
    }
    nodes.push(templateNode(r))
  }

  const pieces: Piece[] = []
  let historySeen = false
  for (const [i, n] of nodes.entries()) {
    const nodeSource = n.source ?? `template:${n.role}`
    if (n.raw) {
      if (n.body.trim() !== '') pieces.push({ kind: 'node', node: textNode(n, n.body, nodeSource), blocks: [{ source: nodeSource, text: n.body }], template: n })
      continue
    }
    let rendered: string
    try {
      rendered = env.renderString(preprocess(n.body), ctx)
    } catch (err) {
      throw new Error(`${where}: узел #${i + 1} %${n.role}: ${err instanceof Error ? err.message : String(err)}`)
    }
    for (const p of parseRendered(rendered, nodeSource, `${where}: узел #${i + 1} %${n.role}`)) {
      if (p.kind === 'text') {
        const blocks = p.blocks.map((b) => ({ source: b.source, text: v.expand(b.text) })).filter((b) => b.text.trim() !== '')
        if (!blocks.length) continue
        const text = blocks.map((b) => b.text).join('\n\n')
        pieces.push({ kind: 'node', node: textNode(n, text, n.source ?? blocks[0]!.source), blocks, template: n })
      } else if (p.kind === 'history') {
        if (historySeen) throw new Error(`${where}: <{ history }> в шаблоне дважды`)
        historySeen = true
        pieces.push({ kind: 'history', injects: p.injects.map((s) => ({ ...s, text: v.expand(s.text) })) })
      } else {
        pieces.push(p)
      }
    }
  }

  // Ведущие system-узлы шаблона — system prompt.
  let lead = 0
  while (lead < pieces.length) {
    const p = pieces[lead]!
    if (p.kind !== 'node' || p.node.role !== 'system') break
    lead++
  }
  const systemBlocks: SystemBlock[] = pieces.slice(0, lead).flatMap((p) => (p.kind === 'node' ? p.blocks : []))

  // Хвост: история, узлы после неё, impersonate.
  const impersonate = input.turn?.impersonate === true
  const tail: PromptNode[] = []
  let injects: InjectSpec[] = []
  let continueNode: PromptNode | undefined
  let impersonateNode: PromptNode | undefined
  const historyIds: string[] = []
  for (const p of pieces.slice(lead)) {
    if (p.kind === 'node') {
      tail.push(p.node)
    } else if (p.kind === 'history') {
      injects = p.injects
      for (const m of input.document.path) {
        historyIds.push(m.id)
        tail.push(historyNode(m, v))
      }
      // Ход без реплики: история кончается ответом — маркер (при именах — «Имя:»).
      const last = input.document.path.filter((m) => !compactionData(m)).at(-1)
      if (!impersonate && last?.role === 'assistant') {
        continueNode = synthetic('continue', 'user', v.voiced && v.turn ? `${v.turn.name}:` : CONTINUE_TEXT, CONTINUE_SOURCE)
        tail.push(continueNode)
      }
    } else if (impersonate) {
      const u = { ...v.userCard }
      // Шаблон сам поставил промпт/хвост персоны (`player.system_prompt` в system,
      // `player.post_history_instructions` в хвосте) — в инструкции их не повторять.
      if (/\bplayer\.system_prompt\b/.test(input.agent.template)) delete u.system_prompt
      if (/\bplayer\.post_history_instructions\b/.test(input.agent.template)) delete u.post_history_instructions
      const instruction = impersonatePrompt(input.agent.impersonate, {
        user: v.names.user ?? 'User',
        char: v.names.char ?? 'Character',
        input: input.turn?.input ?? '',
        persona: {
          ...(str(u.description) ? { description: str(u.description)! } : {}),
          ...(str(u.scenario) ? { scenario: str(u.scenario)! } : {}),
          ...(str(u.system_prompt) ? { system_prompt: str(u.system_prompt)! } : {}),
          ...(str(u.post_history_instructions) ? { post_history_instructions: str(u.post_history_instructions)! } : {}),
        },
      })
      impersonateNode = synthetic('impersonate', 'user', instruction, IMPERSONATE_SOURCE)
      tail.push(impersonateNode)
    }
  }

  // Префил — только последним узлом.
  let prefill: PromptNode | undefined
  const pi = tail.findIndex((n) => n.prefill)
  if (pi >= 0) {
    if (pi !== tail.length - 1) throw new Error(`${where}: %assistant prefill — только последним узлом промпта`)
    prefill = tail.pop()
  }

  // Подсказка хода (personas-spec §2): `\nИмя: ` к последней реплике user.
  // В рецепте — текст узла без подсказки (как assembleRp).
  const recipeText = new Map<PromptNode, string>()
  const end = tail.at(-1)
  if (!impersonate && v.voiced && v.turn && end && end.role === 'user' && end !== continueNode) {
    const hinted = withLastText(end, (t) => `${t}\n${v.turn!.name}: `)
    recipeText.set(hinted, textOf(end))
    tail[tail.length - 1] = hinted
  }

  // Вставки на глубине от конца ленты (без префила): как assembleRp.
  const injected = injects.map((s, k) => ({
    depth: s.at,
    message: { ...synthetic(`inject-${k}`, 'user', s.text, s.source), injectRole: s.role } as PromptNode,
  }))
  const ordered = injectAtDepth(tail, injected)
  const out: PromptNode[] = [
    ...pieces.slice(0, lead).flatMap((p) => (p.kind === 'node' ? [p.node] : [])),
    ...ordered,
    ...(prefill ? [prefill] : []),
  ]

  const recipe = recipeOf({ systemBlocks, v, injects, tail: ordered, prefill, impersonateNode, continueNode, historyIds, input, recipeText })
  const meta = { ...tpl.meta, model: input.model.id, tools: [...input.tools], ...(input.document.greeting ? { greeting: input.document.greeting.index } : {}) }
  return { nodes: out, meta, recipe, mds: toMds(meta, out) }
}

function recipeOf(a: {
  systemBlocks: SystemBlock[]
  v: DocView
  injects: InjectSpec[]
  tail: PromptNode[]
  prefill: PromptNode | undefined
  impersonateNode: PromptNode | undefined
  continueNode: PromptNode | undefined
  historyIds: string[]
  input: BuildInput
  recipeText: Map<PromptNode, string>
}): BuildRecipe {
  const lore = a.v.lore
  const reasons = new Map<string, string>()
  for (const e of [...(lore?.before ?? []), ...(lore?.after ?? [])]) reasons.set(loreSourceLabel(e.source, e.name), e.reason)
  // system: записи лорбука, «отброшено», персона, участники — в порядке system, как assembleRp.
  const loreInj: RpInjection[] = []
  const otherInj: RpInjection[] = []
  for (const b of a.systemBlocks) {
    if (reasons.has(b.source)) loreInj.push({ role: 'system', text: b.text, source: b.source, reason: reasons.get(b.source)! })
    else if (b.source === 'persona.user' || b.source === PERSONA_INJECTION_SOURCE) otherInj.push({ role: 'system', text: b.text, source: b.source })
  }
  const injections: RpInjection[] = [...loreInj]
  if (lore?.dropped.length) {
    injections.push({
      role: 'system',
      text: `не вошли (бюджет ${lore.budget}): ${lore.droppedEntries.map((d) => `${d.label} (≈${d.tokens} tok)`).join(', ')}`,
      source: `lorebook: отброшено ${lore.dropped.length} записей (бюджет)`,
      reason: 'бюджет',
    })
  }
  injections.push(...otherInj)
  if (a.impersonateNode) injections.push({ role: 'user', text: textOf(a.impersonateNode), source: IMPERSONATE_SOURCE })
  for (const s of a.injects) injections.push({ role: s.role, text: s.text, source: s.source, ...(s.reason ? { reason: s.reason } : {}) })
  // Узлы шаблона после истории (post, заметки), затем маркер «продолжай».
  for (const n of a.tail) {
    if (n.history || n.injectRole || n === a.impersonateNode || n === a.continueNode) continue
    injections.push({ role: n.role === 'assistant' ? 'assistant' : n.role === 'system' ? 'system' : 'user', text: a.recipeText.get(n) ?? textOf(n), source: n.source })
  }
  if (a.continueNode) {
    const marker = a.tail.find((n) => n.id === a.continueNode!.id)
    injections.push({ role: 'user', text: textOf(marker ?? a.continueNode), source: CONTINUE_SOURCE })
  }
  if (a.prefill) injections.push({ role: 'assistant', text: textOf(a.prefill), source: a.prefill.source })
  const recipe: BuildRecipe = { systemBlocks: a.systemBlocks, injections, messageIds: a.historyIds }
  if (a.input.document.greeting) recipe.greeting = a.input.document.greeting.index
  return recipe
}

// ────────────────────────────────────────────────────────────────────────────

function textNode(n: TemplateNode, text: string, source: string): PromptNode {
  const node: PromptNode = { role: n.role, parts: [{ type: 'text', text }], source }
  if (n.prefill) node.prefill = true
  if (n.hidden) node.hidden = true
  return node
}

/** Узел истории: `{{char}}`/`{{user}}` — по текущим персонам (DEV-256); при именах — префикс `Имя: ` по персонам. */
function historyNode(m: DtoMessage, v: DocView): PromptNode {
  let msg = m
  if (!compactionData(m) && (m.role === 'user' || m.role === 'assistant')) msg = expandMessageNames(m, v.expand)
  if (v.voiced && !compactionData(m) && (m.role === 'user' || m.role === 'assistant')) {
    const persona = v.doc.personas.find((p) => p.id === speakerOf(m, v))
    if (persona) msg = withFirstText(msg, (t) => personaPrefixed(persona.name, t))
  }
  return { role: msg.role, parts: msg.parts, source: compactionData(m) ? 'compaction' : 'history', id: m.id, history: true }
}

/** Кто сказал (правило assembleRp): `meta.personaId`; user — игрок; ответ — первая `char`. */
function speakerOf(m: DtoMessage, v: DocView): string | undefined {
  const id = m.meta?.personaId
  if (typeof id === 'string') return id
  if (m.role === 'user') return v.user?.id
  if (m.role === 'assistant') return charPersonas(v.doc)[0]?.id ?? v.turn?.id
  return undefined
}

function synthetic(name: string, role: string, text: string, source: string): PromptNode {
  return { id: `${SYNTHETIC_ID_PREFIX}${name}`, role, parts: [{ type: 'text', text }], source }
}

function withFirstText(m: DtoMessage, edit: (t: string) => string): DtoMessage {
  const at = m.parts.findIndex((p) => p.type === 'text')
  if (at < 0) return { ...m, parts: [{ type: 'text', text: edit('') }, ...m.parts] }
  return { ...m, parts: m.parts.map((p, i) => (i === at && p.type === 'text' ? { ...p, text: edit(p.text) } : p)) }
}

function withLastText(n: PromptNode, edit: (t: string) => string): PromptNode {
  let at = -1
  n.parts.forEach((p, i) => {
    if (p.type === 'text') at = i
  })
  if (at < 0) return { ...n, parts: [...n.parts, { type: 'text', text: edit('') }] }
  return { ...n, parts: n.parts.map((p, i) => (i === at && p.type === 'text' ? { ...p, text: edit(p.text) } : p)) }
}

/** `meta` + узлы → `.mds` (nr-chat): `%meta {…}`, затем `%<роль> {source, …}` с текстом. */
export function toMds(meta: Record<string, unknown>, nodes: readonly PromptNode[]): string {
  const records: ChatMessage[] = [{ role: 'meta', meta: { ...meta }, body: '' }]
  for (const n of nodes) {
    const m: Record<string, unknown> = { source: n.source }
    if (n.id !== undefined) m.id = n.id
    if (n.prefill) m.prefill = true
    if (n.hidden) m.hidden = true
    if (n.injectRole) m.inject = n.injectRole
    records.push({ role: n.role, meta: m, body: partsText(n.parts) })
  }
  return stringify(records)
}

function partsText(parts: readonly Part[]): string {
  return parts
    .map((p) => (p.type === 'text' || p.type === 'thinking' ? p.text : `[${p.type}${p.type === 'tool_use' || p.type === 'tool_result' ? ` ${(p.meta as { name?: string }).name ?? ''}`.trimEnd() : ''}]`))
    .filter((t) => t !== '')
    .join('\n')
}

function promptOf(meta: BuildInput['document']['meta']): { pre?: unknown; post?: unknown } {
  const p = meta.prompt
  return p && typeof p === 'object' ? p : {}
}

function personaUserOf(meta: BuildInput['document']['meta']): string | undefined {
  const p = meta.persona as { user?: unknown } | undefined
  return p && typeof p === 'object' && typeof p.user === 'string' && p.user.trim() ? p.user.trim() : undefined
}

function strOf(v: unknown): string {
  if (v === undefined || v === null) return ''
  return String(v)
}

function nonEmpty(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
