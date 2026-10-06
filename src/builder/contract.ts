/**
 * Контракт билдера промпта (session-document-spec §4.1): агент — функция
 * `build(документ, модель) → prompt.mds`. Без IO и `node:*`: шаблон и
 * include-файлы читает платформа и кладёт во вход, билдер чистый — тест
 * агента сравнивает два `.mds`.
 */

import type { Message as DtoMessage, Part, Persona, ProfileDoc } from '../model.js'
import type { ProfileLore, RpInjection, RpSessionMeta } from '../assembly/assemble-rp.js'
import type { SystemBlock } from '../assembly/rp.js'

/** Модель рана — то, что билдеру нужно знать (структурно `ModelInfo` протокола). */
export interface BuildModel {
  id: string
  contextWindow?: number
  maxTokens?: number
  [key: string]: unknown
}

/** Ход: адресат (impersonate — игрок пишет), ход без реплики, ввод композера. */
export interface BuildTurn {
  /** Персона хода (`char`); нет — первая `char`. */
  target?: string
  /** Impersonate: ответить за игрока (`{{input}}` — `input`). */
  impersonate?: boolean
  /** Ход без реплики (`run.continue`) — платформа сама видит по пути; флаг — явная просьба. */
  continue?: boolean
  input?: string
}

/** Агент рана: документ профиля + прочитанные платформой шаблон и include-файлы. */
export type BuildAgent = ProfileDoc & {
  /** Текст шаблона `.mds`. */
  template: string
  /** `%include <путь>` → текст файла (путь — как в шаблоне). */
  includes: Record<string, string>
  /** Откуда шаблон (для ошибок и рецепта): путь или `builtin:agent.mds`. */
  templatePath?: string
}

export interface BuildInput {
  session: { id: string; cwd?: string }
  document: {
    /** Активный путь после компакции (узел компакции — первым, если есть). */
    path: DtoMessage[]
    meta: RpSessionMeta
    personas: Persona[]
    userId?: string
    /** Выбранный гритинг: активный сиблинг первого assistant-узла (`MessageMeta.greeting`). */
    greeting?: { index: number; data?: unknown }
  }
  agent: BuildAgent
  model: BuildModel
  turn?: BuildTurn
  /** Платформенные блоки: каталог скиллов, контекст сервисов. */
  base: SystemBlock[]
  /** Имена тулов рана — в `%meta` выхода. */
  tools: string[]
  budget?: { contextWindow: number; reserveTokens: number }
  /** Книги профиля (`$lorebook*`), прочитаны платформой. */
  profileLore?: ProfileLore
}

/**
 * Узел промпта: путь в провайдер. Ведущие `system`-узлы провайдер склеивает в
 * system prompt; прочие — сообщения. `id` — у узлов истории (id стора), у
 * синтетических — `nr:<…>`.
 */
export interface PromptNode {
  role: 'system' | 'user' | 'assistant' | 'tool' | (string & {})
  parts: Part[]
  source: string
  id?: string
  /** Префикс ответа: последний узел, провайдер отдаёт его как начало ответа. */
  prefill?: boolean
  /** Пометка `hidden` шаблона — модель видит, лента нет. */
  hidden?: boolean
  /** Узел истории (из `document.path`), а не шаблона. */
  history?: boolean
  /** Вставка `inject`: объявленная роль (сообщение уходит user — как в `assembleRp`). */
  injectRole?: 'system' | 'user' | 'assistant'
}

/** Рецепт сборки: что и откуда ушло в модель (`systemBlocks`/`injections` — как у `assembleRp`). */
export interface BuildRecipe {
  systemBlocks: SystemBlock[]
  injections: RpInjection[]
  /** id сообщений стора, ушедших в контекст (без синтетических). */
  messageIds: string[]
  /** Индекс выбранного гритинга, если сборка его видела. */
  greeting?: number
}

export interface BuildOutput {
  nodes: PromptNode[]
  meta: { model: string; tools: string[]; sampling?: Record<string, unknown>; [key: string]: unknown }
  recipe: BuildRecipe
  /** Сериализация `meta` + `nodes` в `.mds` — `effectivePrompt` сессии. */
  mds: string
}

export interface PromptBuilder {
  name: string
  build(input: BuildInput): Promise<BuildOutput>
}

export type { SystemBlock, ProfileLore, RpInjection, RpSessionMeta, Persona, DtoMessage }
