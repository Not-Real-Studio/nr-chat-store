/**
 * assembly/steps — generic-фабрики шагов (spec §4).
 *
 * Ровно четыре: filter / partition / sliceTail / relabel. Без словаря профиля —
 * только модель. Не добавлять «на вырост»: inject-фабрика придёт с первым
 * лорбук-потребителем отдельной таской.
 *
 * Все фабрики строят ЧИСТЫЕ шаги: вход не мутируется, нода копируется только при
 * смене роли (relabel) — остальное переупорядочивает те же ссылки.
 */

import type { StoreNode } from '../model.js'
import type { AssembleCtx, Step } from './contract.js'

/** Оставить ноды, удовлетворяющие предикату. */
export function filter(pred: (n: StoreNode, ctx: AssembleCtx) => boolean): Step {
  return (nodes, ctx) => nodes.filter((n) => pred(n, ctx))
}

/**
 * Стабильный вынос группы: ноды с `pred` едут в начало ('front') или в хвост
 * ('tail'), относительный порядок внутри обеих групп сохраняется.
 */
export function partition(pred: (n: StoreNode, ctx: AssembleCtx) => boolean, place: 'front' | 'tail'): Step {
  return (nodes, ctx) => {
    const yes: StoreNode[] = []
    const no: StoreNode[] = []
    for (const n of nodes) (pred(n, ctx) ? yes : no).push(n)
    return place === 'front' ? [...yes, ...no] : [...no, ...yes]
  }
}

/**
 * Хвост линейки длиной `count(ctx)`. `undefined` — без среза (весь вход);
 * `<= 0` — пусто.
 */
export function sliceTail(count: (ctx: AssembleCtx) => number | undefined): Step {
  return (nodes, ctx) => {
    const c = count(ctx)
    if (c === undefined) return nodes
    if (c <= 0) return []
    return nodes.length > c ? nodes.slice(-c) : nodes
  }
}

/**
 * Смена роли по `fn`. `undefined` — не трогать ноду; иначе роль меняется через
 * КОПИЮ ноды (остальные поля, включая `name`, сохраняются). Возврат прежней
 * роли — нода не копируется.
 */
export function relabel(fn: (n: StoreNode, ctx: AssembleCtx) => string | undefined): Step {
  return (nodes, ctx) =>
    nodes.map((n) => {
      const role = fn(n, ctx)
      return role === undefined || role === n.role ? n : { ...n, role }
    })
}
