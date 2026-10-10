/**
 * `@notrealstudio/nr-chat-store/builder` — билдер промпта: агент = функция
 * `build(документ, модель) → prompt.mds` (session-document-spec §4). Контракт,
 * реестр и билдер `mds-template` (шаблон `.mds` × ntpl).
 *
 * Зависимости сабпата (optional peer пакета): `@notrealstudio/nr-chat` — кодек
 * `.mds`, `@notrealstudio/nrd` + `nunjucks` — ntpl. Без `node:*`.
 */

import type { PromptBuilder } from './contract.js'
import { MDS_TEMPLATE_BUILDER, mdsTemplateBuilder } from './mds-template.js'

export type { BuildAgent, BuildInput, BuildModel, BuildOutput, BuildRecipe, BuildTurn, PromptBuilder, PromptNode } from './contract.js'
export { MDS_TEMPLATE_BUILDER, agentPre, buildMdsTemplate, mdsTemplateBuilder, parseTemplate, templateVocabulary, toMds } from './mds-template.js'
export type { TemplateVocabulary } from './mds-template.js'
export { preprocess, sourceOfExpr } from './tags.js'

/** Реестр билдеров по умолчанию (§4.2): только `mds-template`. */
export function defaultBuilders(): Record<string, PromptBuilder> {
  return { [MDS_TEMPLATE_BUILDER]: mdsTemplateBuilder }
}

/** Билдер агента: `$builder` (нет — `mds-template`); неизвестный — ошибка текстом. */
export function resolveBuilder(builders: Record<string, PromptBuilder>, name: string | undefined): PromptBuilder {
  const key = name?.trim() || MDS_TEMPLATE_BUILDER
  const b = builders[key]
  if (!b) throw new Error(`билдер промпта «${key}» не зарегистрирован (есть: ${Object.keys(builders).join(', ') || 'нет'})`)
  return b
}

/** `$template` профиля: поле документа или атрибут файла (`extra.template`). */
export function agentTemplateOf(profile: { template?: string; extra?: Record<string, string> } | undefined): string | undefined {
  const v = profile?.template ?? profile?.extra?.template
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** `$builder` профиля: поле документа или атрибут файла. */
export function agentBuilderOf(profile: { builder?: string; extra?: Record<string, string> } | undefined): string | undefined {
  const v = profile?.builder ?? profile?.extra?.builder
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
}

/** `$template` — сам текст шаблона (inline-агент), а не путь: начинается с `%`. */
export function isInlineTemplate(value: string): boolean {
  return /^\s*%/.test(value)
}

/** Пути `%include` шаблона (как написаны) — их читает платформа. */
export function templateIncludes(template: string): string[] {
  const out: string[] = []
  for (const line of template.split('\n')) {
    const m = /^%include\s+(.+?)\s*$/.exec(line)
    if (m && !out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}
