/**
 * @notreal/chat-store — реестр драйверов (spec §6).
 *
 * Внешние драйверы — первым классом: sqlite/opencode/openclaw живут в своих
 * пакетах и регистрируются так же, как встроенная тройка. Привилегий у
 * встроенных нет — тройка регистрируется тем же `register`.
 */

import type { SessionStore } from './store.js'

export type StoreFactory = (opts?: unknown) => SessionStore

const registry = new Map<string, StoreFactory>()

/** Зарегистрировать фабрику драйвера под именем. Повторная регистрация заменяет. */
export function register(name: string, factory: StoreFactory): void {
  registry.set(name, factory)
}

/** Снять регистрацию (для тестов/переинициализации). */
export function unregister(name: string): boolean {
  return registry.delete(name)
}

/** Имена зарегистрированных драйверов. */
export function registered(): string[] {
  return [...registry.keys()]
}

/** Создать драйвер по имени. `opts` уходит в фабрику как есть. */
export function getStore(name: string, opts?: unknown): SessionStore {
  const factory = registry.get(name)
  if (!factory) throw new Error(`chat-store: драйвер '${name}' не зарегистрирован`)
  return factory(opts)
}
