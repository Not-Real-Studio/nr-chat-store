/**
 * Агент — файл `.mds` (agents-spec §1, DEV-314): тот же шаблон, что слепок
 * ACP и `$template` профиля nr. Шапка — первая строка `%meta {…}` (`name`,
 * `description`, `engine`, `model`, `effort`, `card`, `voice`, `skills`, …), длинные
 * поля — телом `%%поле` под ней (`%%tools`, `%%files`). Здесь — только текст:
 * файл ↔ `ProfileDoc` («профиль на проводе = агент»); чтение каталогов — у
 * хоста (nr-стенд, backend-acp).
 *
 * Движок берёт из меты то, что понимает, чужое не трогает: `agentText`
 * переписывает только известные поля строки `%meta`, остальное — как было.
 */

import { parse, stringify } from '@notrealstudio/nr-chat'
import type { AgentVoice, ProfileDoc } from '../model.js'
import { parseTemplate } from './mds-template.js'

/** Пример работы агента рядом с ним: `<id>.example.mds` — не агент. */
export const AGENT_EXAMPLE_SUFFIX = '.example.mds'

/** Файл каталога — агент: `*.mds`, кроме примеров и скрытых. */
export function isAgentFile(name: string): boolean {
  return name.endsWith('.mds') && !name.endsWith(AGENT_EXAMPLE_SUFFIX) && !name.startsWith('.')
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)

/** `skills: [a, b]` | `"a, b"` → список. */
function list(v: unknown): string[] | undefined {
  const items = Array.isArray(v) ? v.map((x) => String(x).trim()) : typeof v === 'string' ? v.split(/[,\n]/).map((x) => x.trim()) : []
  const out = items.filter(Boolean)
  return out.length ? out : undefined
}

/** `tools`/`%%tools`: `all` | `none` | список. */
function tools(v: unknown): ProfileDoc['tools'] {
  const items = list(v)
  if (!items) return undefined
  if (items.length === 1 && (items[0] === 'all' || items[0] === 'none')) return items[0]
  return items
}

const VOICE_MODES = ['smart', 'verbatim'] as const
const VOICE_REFINE = ['auto', 'always', 'off'] as const
const VOICE_EMOTIONS = ['off', 'emoji', 'tags'] as const

/**
 * `voice: {mode, refine, emotions, say}` меты → распознавание агента (LLM-12, эмоции диктовки DEV-598) и голос озвучки (DEV-497). Незнакомые
 * значения отбрасываются: пусто — поля нет, клиент берёт глобальную настройку.
 */
export function agentVoiceOf(v: unknown): AgentVoice | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const o = v as Record<string, unknown>
  const mode = VOICE_MODES.find((m) => m === o.mode)
  const refine = VOICE_REFINE.find((r) => r === o.refine)
  const emotions = VOICE_EMOTIONS.find((e) => e === o.emotions)
  const say = typeof o.say === 'string' && o.say.trim() ? o.say.trim() : undefined
  const out: AgentVoice = { ...(mode ? { mode } : {}), ...(refine ? { refine } : {}), ...(emotions ? { emotions } : {}), ...(say ? { say } : {}) }
  return Object.keys(out).length ? out : undefined
}

/**
 * Файл агента → документ. `file` — абсолютный путь: он же `template` (сборка
 * nr читает шаблон и его `%include` с диска на каждом ране; ACP рендерит
 * слепок оттуда же). Битый текст — throw с именем агента.
 */
export function agentDocOf(id: string, text: string, file: string): ProfileDoc {
  const parsed = parseTemplate(text, `агент ${id}`)
  const meta = parsed.meta
  // Шапка без узлов промпта и с `template` (пресет RP, NRP-4): промпт собирает общий шаблон, файл несёт только настройки.
  const headerOnly = !parsed.nodes.length && !parsed.includes.length && str(meta.template) !== undefined
  const doc: ProfileDoc = { id, name: str(meta.name) ?? id, ...(headerOnly ? {} : { template: file }), source: 'agents' }
  const description = str(meta.description)
  if (description) doc.description = description
  const engine = str(meta.engine)
  if (engine) doc.engine = engine
  const model = str(meta.model)
  if (model) doc.model = model
  const effort = str(meta.effort) ?? str(meta.thinking)
  if (effort) doc.thinking = effort
  const card = str(meta.card)
  if (card) doc.card = card
  const voice = agentVoiceOf(meta.voice)
  if (voice) doc.voice = voice
  const skills = list(meta.skills)
  if (skills) doc.skills = skills
  const t = tools(meta.tools)
  if (t) doc.tools = t
  const pre = str(meta.pre)
  const post = str(meta.post)
  if (pre || post) doc.prompt = { ...(pre ? { pre } : {}), ...(post ? { post } : {}) }
  const impersonate = str(meta.impersonate)
  if (impersonate) doc.impersonate = impersonate
  // Прочие поля меты (`tool_policy`, `mcp`, `compaction`, `max_turns`, `tools_extra`…) — в `extra`
  // текстом, как атрибуты старого профиля `.mdz`: движок nr читает их оттуда (agents-spec §1).
  const extra: Record<string, string> = {}
  for (const [k, v] of Object.entries(meta)) {
    if (DOC_KEYS.has(k) || v === undefined || v === null) continue
    extra[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  if (Object.keys(extra).length) doc.extra = extra
  return doc
}

/** Поля меты, которые `agentDocOf` кладёт в документ сам (остальные — в `extra`). */
const DOC_KEYS = new Set(['name', 'description', 'engine', 'model', 'effort', 'thinking', 'card', 'voice', 'skills', 'tools', 'pre', 'post', 'impersonate'])

/** Тела `%%поле` под шапкой, которыми владеет документ (длинный текст не в строке `%meta`). */
const BODY_KEYS = ['tools', 'pre', 'post', 'impersonate'] as const

/** Текст поля-тела из документа; `tools` не задан — `undefined`: тело файла остаётся как было. */
function bodyFields(doc: ProfileDoc): Partial<Record<(typeof BODY_KEYS)[number], string>> {
  const out: Partial<Record<(typeof BODY_KEYS)[number], string>> = {}
  if (doc.tools !== undefined) out.tools = Array.isArray(doc.tools) ? doc.tools.join('\n') : doc.tools
  if (doc.prompt?.pre?.trim()) out.pre = doc.prompt.pre.trim()
  if (doc.prompt?.post?.trim()) out.post = doc.prompt.post.trim()
  if (doc.impersonate?.trim()) out.impersonate = doc.impersonate.trim()
  return out
}

/** Комментарий до первого узла и узлы отдельно: `%%`-поля идут сразу за комментарием, иначе он попал бы в поле. */
function splitHead(body: string): [string, string] {
  const at = body.search(/^%/m)
  return at < 0 ? [body, ''] : [body.slice(0, at), body.slice(at)]
}

/** Убрать из начала узлов `%%`-поля документа. Текст остального не переписывается: чужие `%%` и шаблон — как были. */
function withoutBodyFields(nodes: string, doc: ProfileDoc): string {
  const lines = nodes.split('\n')
  const kept: string[] = []
  let i = 0
  while (i < lines.length) {
    const key = /^%%(\S+)/.exec(lines[i]!)?.[1]
    if (key === undefined) break
    let end = i + 1
    while (end < lines.length && !lines[end]!.startsWith('%')) end++
    const own = key === 'tools' ? doc.tools !== undefined : (BODY_KEYS as readonly string[]).includes(key)
    if (!own) kept.push(...lines.slice(i, end))
    i = end
  }
  return [...kept, ...lines.slice(i)].join('\n')
}

/** Значение `extra` обратно в мету: JSON-объект и список — разобранными, как были в файле. */
function extraValue(v: string): unknown {
  if (!/^[[{]/.test(v.trim())) return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

/** Поля строки `%meta`, которыми владеет документ: остальные ключи — как были. */
const OWN_KEYS = ['name', 'description', 'engine', 'model', 'effort', 'card', 'voice', 'skills'] as const

/** Тело нового агента: system документа (старый профиль nr — его `systemPrompt`) и история. */
function newBody(doc: ProfileDoc): string {
  const system = doc.systemPrompt?.trim() || `Ты — агент «${doc.name || doc.id}».`
  return ['%system', system, '%user', '<{ history }><{ endhistory }>', ''].join('\n')
}

/**
 * Документ → текст агента. Есть прежний текст — меняется только строка
 * `%meta` (поля документа; чужие ключи и `%%`-тела — как были), тело
 * шаблона не трогается. Нет — новый агент: `%meta`, `%system`, история.
 */
export function agentText(doc: ProfileDoc, existing?: string): string {
  let prev: Record<string, unknown> = {}
  let body: string
  if (existing !== undefined) {
    const nl = existing.indexOf('\n')
    const first = nl < 0 ? existing : existing.slice(0, nl)
    if (/^%meta\b/.test(first)) {
      prev = { ...(parse(first)[0]?.meta ?? {}) }
      body = nl < 0 ? '' : existing.slice(nl + 1)
    } else body = existing
  } else body = doc.extra?.template ? '' : newBody(doc)
  const meta: Record<string, unknown> = {}
  const own: Record<string, unknown> = {
    name: doc.name || doc.id,
    description: doc.description,
    engine: doc.engine,
    model: doc.model,
    effort: doc.thinking,
    card: doc.card,
    voice: doc.voice && Object.keys(doc.voice).length ? { ...doc.voice } : undefined,
    skills: doc.skills?.length ? doc.skills : undefined,
  }
  for (const k of OWN_KEYS) if (own[k] !== undefined && own[k] !== '') meta[k] = own[k]
  // `extra` задан — он и есть прочие поля (документ читал их из этого же файла); нет — поля файла как были.
  if (doc.extra) for (const [k, v] of Object.entries(doc.extra)) if (!DOC_KEYS.has(k)) meta[k] = extraValue(v)
  else for (const [k, v] of Object.entries(prev)) if (!(OWN_KEYS as readonly string[]).includes(k) && k !== 'thinking') meta[k] = v
  const line = stringify([{ role: 'meta', meta, body: '' }]).trim()
  const fields = stringify(Object.entries(bodyFields(doc)).map(([k, v]) => ({ role: `%${k}`, body: v }))).trimStart()
  const [comment, nodes] = splitHead(body)
  return `${line}\n${comment}${fields}${withoutBodyFields(nodes, doc)}`
}
