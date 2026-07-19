/**
 * assembly/contract — контракт policy-трансформа линеек (spec §3).
 *
 * Третье семейство адаптеров вокруг модели store (рядом с драйверами и
 * encoding): чистый sync-трансформ `StoreNode[] → StoreNode[]`. Ноль IO, ноль
 * знания о проводе и хранении. Только модель.
 *
 * Инварианты контракта (энфорсятся тестами):
 *  - шаг ЧИСТ: не мутирует вход (ноды копируются при изменении — паттерн relabel);
 *  - шаг ТОТАЛЕН: любой StoreNode[] легален, незнакомые роли/атрибуты — данные
 *    насквозь (IL-инвариант);
 *  - порядок применения — забота композиции, не шага.
 *
 * Canon: S:\skills\nr-system.dev\specs\nr-chat-store-assembly-spec.md
 */

import type { StoreNode } from '../model.js'

export interface AssembleCtx {
  /** Открытый словарь параметров профиля (as, limit, …). Шаги читают что знают. */
  params: Record<string, unknown>
  /**
   * Режим спеки §4: v1 реализует только 'live'; 'replay' — зарезервирован, шаги
   * обязаны его не ломать (селект не фильтрует injected в replay — spec §5.3).
   */
  mode: 'live' | 'replay'
}

/** Чистый шаг трансформа: линейка + контекст → линейка. */
export type Step = (nodes: StoreNode[], ctx: AssembleCtx) => StoreNode[]

/** Композиция шагов слева направо: `compose(a, b)(x) = b(a(x))`. */
export function compose(...steps: Step[]): Step {
  return (nodes, ctx) => steps.reduce((acc, step) => step(acc, ctx), nodes)
}
