/**
 * Расширения `SessionStore` сверх контракта (DEV-237): то, что живой бэкенд
 * (store-backend) держит в самой сессии — выбор модели/профиля, персоны,
 * рецепты промптов, узлы компакции. Форма общая для драйверов: pi пишет их
 * служебными записями (`nr-session-*`, `nr-prompt-recipe`, `compaction`),
 * nr-chat — шапкой `%meta` и метой узла. Потребитель видит только эти
 * интерфейсы — драйвер меняется без правки бэкенда.
 *
 * Расширение необязательно: нет метода — бэкенд держит это в памяти процесса
 * (фикстуры) или не заявляет capability.
 */

import type { CompactionData } from './assembly/engine.js'
import type { ProfileDoc, StoreNode } from './model.js'
import type { SessionStore } from './store.js'

/** Выбор модели сессии: `provider` — как пишет драйвер (pi — поле `model_change`). */
export interface StoreModelChoice {
  provider?: string
  model: string
  thinking?: string
}

/** Выбор сессии, переживающий рестарт бэкенда: модель и профиль. */
export interface StoreSessionChoices {
  model?: StoreModelChoice
  /** id профиля каталога; встроенный профиль — `'inline'` с документом в `profileDoc`. */
  profile?: string
  profileDoc?: ProfileDoc
}

/** Хранение выбора в сессии: `set` пишет только то, что изменилось. */
export interface StoreChoicesApi {
  get(sid: string): Promise<StoreSessionChoices>
  set(sid: string, choices: StoreSessionChoices): Promise<void>
}

/** Документ персон сессии (personas-spec §1): целиком. */
export interface StorePersonasDoc {
  personas: unknown[]
  userId?: string
}

export interface StorePersonasApi {
  get(sid: string): Promise<StorePersonasDoc>
  set(sid: string, doc: StorePersonasDoc): Promise<void>
}

/**
 * Рецепты промптов ответов (prompt-recipe-spec §3): данные рецепта —
 * `{forMessageId, …}`, тексты кусков — по хэшу (один раз на хэш).
 */
export interface StoreRecipesApi {
  put(sid: string, data: Record<string, unknown> & { forMessageId: string }, texts: ReadonlyMap<string, string>): Promise<void>
  /** Последний рецепт ответа `messageId` и тексты его кусков; нет — `undefined`. */
  get(sid: string, messageId: string): Promise<{ data: Record<string, unknown>; texts: Map<string, string> } | undefined>
  /**
   * `.mds` промпта последнего рана (`effectivePrompt`, session-document-spec
   * §4.1) — в хранилище, не в памяти процесса. Нет — бэкенд держит его в памяти.
   */
  effective?: {
    get(sid: string): Promise<string | undefined>
    set(sid: string, mds: string): Promise<void>
  }
}

/** Узел компакции: тело записи `compaction` (+ usage вызова резюме, родитель). */
export interface StoreCompactionInput extends CompactionData {
  usage?: { input: number; output: number }
  /** Родитель узла; нет — текущий лист. */
  parent?: string
}

export interface StoreCompactionApi {
  append(sid: string, input: StoreCompactionInput): Promise<StoreNode>
}

/** `SessionStore` с расширениями живого бэкенда. */
export type ExtendedSessionStore = SessionStore & {
  choices?: StoreChoicesApi
  compaction?: StoreCompactionApi
  personas?: StorePersonasApi
  recipes?: StoreRecipesApi
}
