/**
 * assembly/rp — чистые куски RP-сборки (DEV-222), общие для pi-ext-session-meta
 * и backend-nr: порядок story string, вставка на глубине, шаблон impersonate с
 * макросами, маркер «продолжай». Без IO и провода; персоны (имена, блок
 * участников) — в nr-ui-protocol, он и так у обоих потребителей.
 *
 * Происхождение: `effectiveSystemPrompt`/`injectDepthPrompt` — pi-ext-session-meta
 * (`meta.ts`), макросы и шаблон — плагин `rp` nrchat (`model.ts`), маркер —
 * pi-ext (`continue.ts`). Семантика один в один: приёмки RP-1* сверяют.
 */

// ────────────────────────────────────────────────────────────────────────────
// Story string (session-meta-spec §8): лор до · pre · лор после · персона игрока
// ────────────────────────────────────────────────────────────────────────────

/** Кусок system с источником — для рецепта (system по блокам). */
export interface SystemBlock {
  source: string
  text: string
}

/** Обрамление карточки на ране: тексты уже раскрыты. */
export interface StoryFrame {
  /** Записи лорбука до карточки (`before_char`). */
  before?: readonly SystemBlock[]
  /** Карточка бота — `prompt.pre` меты (раскрыт). */
  pre?: string
  /** Записи лорбука после карточки (`after_char`). */
  after?: readonly SystemBlock[]
  /** Блок персоны игрока (`<Имя>'s Persona: …`). */
  persona?: string
}

/**
 * System рана по story string ST: `before · pre · after · persona`, затем
 * штатный (`base`: system профиля, каталог скиллов). `replace` с `pre` — без
 * штатного; `replace` без `pre` — штатный остаётся (снять свой текст ≠ оставить
 * модель без инструкций). Пустые куски выпадают. Блоки — для рецепта.
 *
 * Семантика — `effectiveSystemPrompt` pi-ext-session-meta (§7, RP-1b).
 */
export function storyString(
  frame: StoryFrame,
  base: readonly SystemBlock[] = [],
  mode: 'append' | 'replace' = 'append',
): { system: string; blocks: SystemBlock[] } {
  const head: SystemBlock[] = [
    ...(frame.before ?? []),
    ...(frame.pre !== undefined ? [{ source: 'meta.pre', text: frame.pre }] : []),
    ...(frame.after ?? []),
    ...(frame.persona ? [{ source: 'persona.user', text: frame.persona }] : []),
  ].filter((b) => b.text.trim() !== '')
  const tail = base.filter((b) => b.text !== '')
  const blocks = head.length && frame.pre !== undefined && mode === 'replace' ? head : [...head, ...tail]
  return { system: blocks.map((b) => b.text).join('\n\n'), blocks }
}

/**
 * Копия истории со вставкой на глубине `depth` от конца (0 — в самый конец).
 * Вставок несколько — каждая на своей глубине от конца ИСХОДНОЙ истории;
 * при равной — в порядке списка.
 */
export function injectAtDepth<M>(messages: readonly M[], items: ReadonlyArray<{ depth: number; message: M }>): M[] {
  if (!items.length) return [...messages]
  const n = messages.length
  const at = (d: number) => Math.max(0, n - Math.max(0, Math.floor(d)))
  const out: M[] = []
  for (let i = 0; i <= n; i++) {
    for (const it of items) if (at(it.depth) === i) out.push(it.message)
    if (i < n) out.push(messages[i]!)
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Impersonate (personas-spec §9): шаблон профиля × макросы
// ────────────────────────────────────────────────────────────────────────────

/**
 * Дефолтный шаблон — когда в профиле нет блока `## $impersonate`. Пустой
 * макрос выбрасывает свою строку: без scenario и ввода остаётся одна инструкция.
 */
export const DEFAULT_IMPERSONATE_TEMPLATE = "Write {{user}}'s next reply in first person, in {{user}}'s voice; do not write for {{char}}.\n{{scenario}}\n{{input}}"

/** Поля персоны игрока, которые видит impersonate (`description` — и бот тоже). */
export interface ImpersonatePersona {
  description?: string
  scenario?: string
  system_prompt?: string
  post_history_instructions?: string
}

/** Из чего считаются макросы одного impersonate. */
export interface MacroVars {
  user: string
  char: string
  /** Текст композера / аргумент `/impersonate`: что сказать или сделать. */
  input: string
  persona: ImpersonatePersona
}

/**
 * Таблица макросов: имя (без регистра) → значение. Новый макрос — строка
 * таблицы. `{{user}}`/`{{char}}` внутри полей персоны раскрываются.
 */
export const IMPERSONATE_MACROS: Record<string, (v: MacroVars) => string> = {
  user: (v) => v.user,
  char: (v) => v.char,
  input: (v) => v.input.trim(),
  persona: (v) => names(v.persona.description, v),
  scenario: (v) => names(v.persona.scenario, v),
  persona_system: (v) => names(v.persona.system_prompt, v),
  persona_post: (v) => names(v.persona.post_history_instructions, v),
}

function names(text: string | undefined, v: MacroVars): string {
  return (text ?? '').trim().replace(/\{\{\s*user\s*\}\}|<user>/gi, v.user).replace(/\{\{\s*char\s*\}\}|<bot>/gi, v.char)
}

const MACRO = /\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g

/** Имена макросов шаблона (в нижнем регистре). */
export function macrosOf(template: string): Set<string> {
  return new Set([...template.matchAll(MACRO)].map((m) => m[1]!.toLowerCase()))
}

/**
 * Шаблон × таблица значений. Строка, где хоть один ИЗВЕСТНЫЙ макрос пуст,
 * выпадает целиком. Незнакомые макросы остаются как написаны.
 */
export function renderMacros(template: string, values: Record<string, string>): string {
  const out: string[] = []
  for (const line of template.split('\n')) {
    let empty = false
    const rendered = line.replace(MACRO, (whole, name: string) => {
      const value = values[name.toLowerCase()]
      if (value === undefined) return whole
      if (value === '') empty = true
      return value
    })
    if (!empty) out.push(rendered)
  }
  return out.join('\n').trim()
}

/**
 * Инструкция impersonate в конец истории: `[persona_system] → шаблон → [persona_post]`.
 * Шаблон сам ставит `{{persona_system}}`/`{{persona_post}}` — тогда авто-вставки нет.
 */
export function impersonatePrompt(template: string | undefined, vars: MacroVars): string {
  const tpl = template?.trim() ? template : DEFAULT_IMPERSONATE_TEMPLATE
  const values = Object.fromEntries(Object.entries(IMPERSONATE_MACROS).map(([k, f]) => [k, f(vars)]))
  const used = macrosOf(tpl)
  const parts = [used.has('persona_system') ? '' : values.persona_system!, renderMacros(tpl, values), used.has('persona_post') ? '' : values.persona_post!]
  return parts.filter((p) => p.trim() !== '').join('\n\n')
}

/**
 * Склейка начала из композера с продолжением модели: модель часто повторяет
 * процитированное начало — повтор срезается, на шве — пробел.
 */
export function joinStart(start: string, continuation: string): string {
  if (start === '') return continuation
  const head = start.trimEnd()
  let rest = continuation
  if (rest.trimStart().startsWith(head)) rest = rest.trimStart().slice(head.length)
  if (rest === '') return start
  const needsSpace = !/\s$/.test(start) && !/^[\s.,!?;:…)»]/.test(rest)
  return start + (needsSpace ? ' ' : '') + rest
}

/** Срезать `Имя:` в начале, если модель всё-таки подписалась. */
export function stripName(text: string, user: string): string {
  const prefix = `${user}:`
  const t = text.trimStart()
  return t.startsWith(prefix) ? t.slice(prefix.length).trimStart() : text
}

// ────────────────────────────────────────────────────────────────────────────
// «Продолжай» (протокол v1.10, `run.continue`): ход без реплики
// ────────────────────────────────────────────────────────────────────────────

/** Текст маркера `/nr-continue` pi (в файле); модели — когда имён нет. */
export const CONTINUE_TEXT = 'Продолжай.'

/** Флаг маркера на user-сообщении pi (`nrContinue: true`). */
export const CONTINUE_FLAG = 'nrContinue'
