/**
 * @notrealstudio/nr-chat-store — driver registry (spec §6).
 *
 * External drivers are first-class: sqlite/opencode/openclaw live in their own
 * packages and register the same way as the built-in trio. The built-ins have
 * no privileges — the trio registers via the same `register`.
 */

import type { SessionStore } from './store.js'

export type StoreFactory = (opts?: unknown) => SessionStore

const registry = new Map<string, StoreFactory>()

/** Register a driver factory under a name. Re-registration replaces. */
export function register(name: string, factory: StoreFactory): void {
  registry.set(name, factory)
}

/** Unregister (for tests/re-initialization). */
export function unregister(name: string): boolean {
  return registry.delete(name)
}

/** Names of the registered drivers. */
export function registered(): string[] {
  return [...registry.keys()]
}

/** Create a driver by name. `opts` is passed to the factory as-is. */
export function getStore(name: string, opts?: unknown): SessionStore {
  const factory = registry.get(name)
  if (!factory) throw new Error(`nr-chat-store: driver '${name}' is not registered`)
  return factory(opts)
}
