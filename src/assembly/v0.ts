/**
 * assembly/v0 — профиль словаря mds-runtime-spec v0 (site.dev) поверх
 * generic-шагов (spec §5). Версионируется со спекой словаря — потому отдельный
 * модуль; contract/steps о словаре не знают.
 *
 * Две оси словаря (spec §5.1):
 *  - АВТОРСТВО (relabel): `speaker(n) = meta.side ?? n.name`, string. Перспектива
 *    вызова — `params.as` («за кого играем этим вызовом»). 'bot'/'player' —
 *    сим-конвенция значений, не контракт. Ролевой дефолт при отсутствии
 *    side/name: assistant→'bot', user→'player' (честная лента дуэли). Внимание:
 *    name СИЛЬНЕЕ ролевого дефолта — голый именованный контент без явного side в
 *    дуэльном файле = не-нормализованные данные (нормализация — обязанность
 *    компилятора/bake).
 *  - АУДИТОРИЯ (select): `meta.audience?: string[]` — кому видно. Нет атрибута —
 *    видно всем; есть — нода едет только при `params.as ∈ audience`. Дефолт: явный
 *    `meta.side` без `audience` → аудитория `[side]` (текущее sim-поведение).
 *
 * Инвариант: hidden ВКЛЮЧАЕТСЯ в промпт; select режет только role='meta',
 * flags.injected (live) и ноды вне аудитории.
 *
 * assembleV0 при params {as, limit} в дуэльном файле (side без audience) —
 * бит-в-бит равно старому sim/lib/assemble.assemble (главный регресс-критерий).
 */

import type { StoreNode } from '../model.js'
import type { AssembleCtx, Step } from './contract.js'
import { compose } from './contract.js'
import { filter, partition, relabel } from './steps.js'

// ── чтения открытого словаря params ─────────────────────────────────────────

function asOf(ctx: AssembleCtx): string | undefined {
  const a = ctx.params.as
  return typeof a === 'string' ? a : undefined
}

function limitOf(ctx: AssembleCtx): number | undefined {
  const l = ctx.params.limit
  return typeof l === 'number' ? l : undefined
}

// ── словарь v0 ──────────────────────────────────────────────────────────────

/**
 * Авторство ноды (spec §5.1): явный `meta.side`, иначе имя, иначе ролевой дефолт
 * честной ленты (assistant→'bot', user→'player'). Прочее без side/name — общее
 * (undefined → relabel не трогает).
 */
export function speaker(n: StoreNode): string | undefined {
  const side = n.meta?.side
  if (typeof side === 'string') return side
  if (n.name) return n.name
  if (n.role === 'assistant') return 'bot'
  if (n.role === 'user') return 'player'
  return undefined
}

/** Видима ли нода перспективе `as` (spec §5.1). */
function visibleTo(n: StoreNode, as: string | undefined): boolean {
  const aud = n.meta?.audience
  if (Array.isArray(aud)) return as !== undefined && aud.includes(as)
  const side = n.meta?.side
  if (typeof side === 'string') return side === as
  return true // нет side/audience → видно всем
}

const isPost = (n: StoreNode): boolean => n.meta?.position === 'post'
const isSysPrefix = (n: StoreNode): boolean => n.role === 'system' && !isPost(n)

// ── шаги профиля (spec §5.2) ────────────────────────────────────────────────

/** select: минус meta / injected(live) / вне-аудитории. */
export const selectV0: Step = filter((n, ctx) => {
  if (n.role === 'meta') return false
  // §5.3 replay-точка: injected режется ТОЛЬКО в live; в replay — записанный факт.
  if (ctx.mode === 'live' && n.flags?.injected) return false
  return visibleTo(n, asOf(ctx))
})

/** order: system-префиксы → front, position:'post' → tail (partition ×2). */
export const orderV0: Step = compose(partition(isPost, 'tail'), partition(isSysPrefix, 'front'))

/**
 * trim: хвост контентной истории длиной `params.limit` (не считая system/post).
 * Концептуально sliceTail, но по подмножеству — потому v0-знание, а не голый
 * generic. `limit` не задан → без среза.
 */
export const trimV0: Step = (nodes, ctx) => {
  const limit = limitOf(ctx)
  if (limit === undefined) return nodes
  const isHist = (n: StoreNode): boolean => !(n.role === 'system' || isPost(n))
  const hist = nodes.filter(isHist)
  if (hist.length <= limit) return nodes
  const keep = new Set<StoreNode>(hist.slice(-limit))
  return nodes.filter((n) => !isHist(n) || keep.has(n))
}

/**
 * relabel: перспектива профиля. speaker === params.as → 'assistant', иначе 'user'.
 * system не трогать; undefined speaker (нет side/name, не assistant/user) — насквозь.
 * `name` сохраняется при смене role (generic relabel копирует ноду целиком).
 */
export const relabelV0: Step = relabel((n, ctx) => {
  if (n.role === 'system') return undefined
  const s = speaker(n)
  if (s === undefined) return undefined
  return s === asOf(ctx) ? 'assistant' : 'user'
})

/** L0-ассембли профиля v0 (spec §5.2). */
export const assembleV0: Step = compose(selectV0, orderV0, trimV0, relabelV0)
