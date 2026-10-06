/**
 * `./migrate` (DEV-237) — перенос сессии между драйверами и стор «новый формат +
 * старые файлы только чтением».
 *
 * Оба — поверх контракта `SessionStore` и его расширений (`choices`,
 * `personas`, `recipes`): драйверы не знают друг о друге, файлы — дело
 * драйверов. Типичный случай — pi → nr-chat (nr-driver-switch-spec §3):
 *
 *   const nr = createNrChatStore({ dir: 'sessions/nr' })
 *   const pi = createPiStore({ dir: piDir, codecs: […], piServiceEntries: 'hide' })
 *   await migrateSession(pi, nr, sid)            // исходник не трогается
 *   const store = withLegacySessions(nr, pi)      // стенд: видит оба каталога
 *
 * Fidelity: id узлов, parent, роли, имена, части, флаги, мета узлов, активный
 * лист, заголовок и бот, мета сессии, персоны, выбор модели/профиля, рецепты с
 * текстами. Вложения — копией через `assets` (ref переписывается в частях и
 * аватарах персон); внешние URL и `data:` — как есть.
 */

import type { ExtendedSessionStore, StorePersonasDoc } from './extensions.js'
import type { Part, SessionInfo, SessionModel, StoreNode } from './model.js'
import { StoreSessionNotFound, paginate, type NodePatch, type SessionStore } from './store.js'
import { activeLeaf, resolveTree, toHistory } from './tree.js'

/** Ключ меты сессии старого формата (`meta.get`): `'pi/2'`. Синтетический — не хранится. */
export const LEGACY_FORMAT_KEY = 'legacyFormat'

export interface MigrateOptions {
  /** Сессия с таким id в приёмнике уже есть — перезаписать (удалить и перенести заново). Default — ошибка. */
  overwrite?: boolean
  warn?: (message: string) => void
}

export interface MigrateReport {
  id: string
  nodes: number
  /** Скопированные вложения: старый ref → новый. */
  assets: Record<string, string>
  recipes: number
  personas: number
  meta: boolean
  choices: boolean
}

/** Сессия `sid` из `src` в `dst` (создаётся с тем же id). Исходник только читается. */
export async function migrateSession(src: ExtendedSessionStore, dst: ExtendedSessionStore, sid: string, opts: MigrateOptions = {}): Promise<MigrateReport> {
  const warn = opts.warn ?? (() => {})
  const model = await src.load(sid)
  const exists = await dst.load(sid).then(
    () => true,
    () => false,
  )
  if (exists) {
    if (!opts.overwrite) throw new Error(`nr-chat-store/migrate: сессия ${sid} в приёмнике уже есть`)
    if (!dst.delete) throw new Error(`nr-chat-store/migrate: приёмник не умеет delete — перезаписать ${sid} нельзя`)
    await dst.delete(sid)
  }

  const info = model.info
  await dst.create({
    id: sid,
    info: {
      ...(info.title ? { title: info.title } : {}),
      ...(info.botId ? { botId: info.botId } : {}),
      ...(info.botName ? { botName: info.botName } : {}),
      ...(info.botAvatar ? { botAvatar: info.botAvatar } : {}),
      ...(info.accentColor ? { accentColor: info.accentColor } : {}),
      ...(info.createdAt ? { createdAt: info.createdAt } : {}),
    },
  })

  // Вложения: каждый ref частей и аватаров — копией (один раз на ref).
  const refs = new Map<string, string>()
  const copyRef = async (ref: unknown): Promise<string | undefined> => {
    if (typeof ref !== 'string' || ref === '' || isExternalRef(ref)) return undefined
    if (refs.has(ref)) return refs.get(ref)
    if (!src.assets?.get || !dst.assets) {
      warn(`вложение ${ref}: у драйвера нет assets — ref оставлен как есть`)
      return undefined
    }
    try {
      const got = await src.assets.get(sid, ref)
      const put = await dst.assets.put(sid, assetNameOf(ref), got.data, got.mime)
      refs.set(ref, put.ref)
      return put.ref
    } catch (err) {
      warn(`вложение ${ref} не скопировано — ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }
  const remapParts = async (parts: Part[]): Promise<Part[]> => {
    const out: Part[] = []
    for (const part of parts) {
      if ((part.type === 'image' || part.type === 'file') && part.meta) {
        const ref = await copyRef((part.meta as { ref?: unknown }).ref)
        out.push(ref ? ({ ...part, meta: { ...part.meta, ref } } as Part) : part)
      } else out.push(part)
    }
    return out
  }

  // Узлы — родитель раньше ребёнка, в порядке файла.
  const done = new Set<string>()
  let pending: StoreNode[] = [...model.nodes]
  while (pending.length) {
    const next: StoreNode[] = []
    for (const node of pending) {
      if (node.parent !== null && !done.has(node.parent) && model.nodes.some((n) => n.id === node.parent)) {
        next.push(node)
        continue
      }
      await dst.appendNode(sid, {
        id: node.id,
        role: node.role,
        ...(node.name !== undefined ? { name: node.name } : {}),
        parts: await remapParts(node.parts),
        parent: node.parent !== null && done.has(node.parent) ? node.parent : null,
        ...(node.flags ? { flags: node.flags } : {}),
        ...(node.meta ? { meta: node.meta } : {}),
      })
      done.add(node.id)
    }
    if (next.length === pending.length) throw new Error(`nr-chat-store/migrate: цикл родителей в ${sid}`)
    pending = next
  }
  const leaf = activeLeaf(model)
  if (leaf && dst.setActiveLeaf) await dst.setActiveLeaf(sid, leaf.id)

  const report: MigrateReport = { id: sid, nodes: done.size, assets: {}, recipes: 0, personas: 0, meta: false, choices: false }

  if (src.meta && dst.meta) {
    const { [LEGACY_FORMAT_KEY]: _l, ...doc } = await src.meta.get(sid)
    if (Object.keys(doc).length) {
      if (dst.meta.set) await dst.meta.set(sid, doc)
      else await dst.meta.patch(sid, doc)
      report.meta = true
    }
  }
  if (src.personas && dst.personas) {
    const doc = await src.personas.get(sid)
    if (doc.personas.length) {
      const personas: unknown[] = []
      for (const p of doc.personas) {
        if (p && typeof p === 'object' && !Array.isArray(p) && typeof (p as { avatar?: unknown }).avatar === 'string') {
          const ref = await copyRef((p as { avatar: string }).avatar)
          personas.push(ref ? { ...(p as object), avatar: ref } : p)
        } else personas.push(p)
      }
      const out: StorePersonasDoc = { personas }
      if (doc.userId !== undefined) out.userId = doc.userId
      await dst.personas.set(sid, out)
      report.personas = personas.length
    }
  }
  if (src.choices && dst.choices) {
    const c = await src.choices.get(sid)
    if (c.model || c.profile) {
      await dst.choices.set(sid, c)
      report.choices = true
    }
  }
  if (src.recipes && dst.recipes) {
    for (const node of model.nodes) {
      if (node.role !== 'assistant') continue
      const got = await src.recipes.get(sid, node.id).catch(() => undefined)
      if (!got) continue
      await dst.recipes.put(sid, { ...got.data, forMessageId: node.id }, got.texts)
      report.recipes++
    }
  }
  // Бот из исходника (pi выводит его из персон) — заголовок приёмника его уже знает
  // через personas.set; title — create. Переименование, если create его не взял.
  if (info.title && dst.rename) {
    const now = (await dst.load(sid)).info
    if (now.title !== info.title) await dst.rename(sid, info.title)
  }
  report.assets = Object.fromEntries(refs)
  return report
}

/**
 * Сверка переноса: `toHistory` обеих сторон равны (ref вложений приведены
 * обратно к исходным), активные листы совпадают. Пустой массив — совпало.
 */
export async function verifyMigration(src: SessionStore, dst: SessionStore, sid: string, assets: Record<string, string>): Promise<string[]> {
  const back = new Map(Object.entries(assets).map(([a, b]) => [b, a]))
  const norm = (m: SessionModel): string =>
    stableJson(
      toHistory(m, resolveTree(m.nodes)).map((msg) => ({
        ...msg,
        hash: undefined,
        parts: msg.parts.map((p) => {
          const meta = (p as { meta?: Record<string, unknown> }).meta
          const ref = meta?.ref
          return typeof ref === 'string' && back.has(ref) ? ({ ...p, meta: { ...meta, ref: back.get(ref) } } as Part) : p
        }),
      })),
    )
  const [a, b] = await Promise.all([src.load(sid), dst.load(sid)])
  const out: string[] = []
  if (norm(a) !== norm(b)) out.push('история активного пути различается')
  if (activeLeaf(a)?.id !== activeLeaf(b)?.id) out.push(`активный лист: ${activeLeaf(a)?.id} ≠ ${activeLeaf(b)?.id}`)
  if (a.nodes.length !== b.nodes.length) out.push(`узлов: ${a.nodes.length} ≠ ${b.nodes.length}`)
  return out
}

/** JSON с ключами по алфавиту (порядок ключей у драйверов разный). */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
}

function isExternalRef(ref: string): boolean {
  return /^(https?|data|blob):/i.test(ref)
}

/** Имя файла вложения в приёмнике: хвост ref без каталога. */
function assetNameOf(ref: string): string {
  const tail = ref.replace(/^file:/, '').split('/').pop() ?? ref
  return tail || 'asset'
}

// ────────────────────────────────────────────────────────────────────────────
// withLegacySessions
// ────────────────────────────────────────────────────────────────────────────

export interface LegacyStoreOptions {
  /** Формат старых сессий для `meta.get` (`legacyFormat`). Default `'pi/2'`. */
  format?: string
  warn?: (message: string) => void
  /** После миграции сессии (лог, метрика). */
  onMigrate?: (report: MigrateReport) => void
}

/**
 * Стор нового формата, который видит и старые сессии (nr-driver-switch-spec §1):
 * список — объединение (одинаковый id — новый формат), чтение — откуда есть,
 * любая запись в старую сессию — сначала {@link migrateSession} в основной стор,
 * потом запись туда. Старый файл не меняется никогда. `meta.get` старой сессии
 * несёт `legacyFormat` (бейдж «старый формат»); патч `{legacyFormat: null}` —
 * запись, то есть конвертация.
 *
 * Удаление старой сессии — отказ (старые файлы только читаются).
 */
export function withLegacySessions(primary: ExtendedSessionStore, legacy: ExtendedSessionStore, opts: LegacyStoreOptions = {}): ExtendedSessionStore {
  const format = opts.format ?? 'pi/2'
  const migrating = new Map<string, Promise<void>>()
  /** Найдено в основном — навсегда там (кэш: проверка — разбор файла). */
  const inPrimary = new Set<string>()
  const inLegacy = new Set<string>()

  /**
   * Где сессия: `primary` / `legacy`; нет нигде — not_found. Основной
   * проверяется и для известных старых: файла нет — проверка дешёвая, а
   * сессию мог перенести параллельный `migrate-session`.
   */
  async function where(sid: string): Promise<'primary' | 'legacy'> {
    if (inPrimary.has(sid)) return 'primary'
    if (await has(primary, sid)) {
      inPrimary.add(sid)
      inLegacy.delete(sid)
      return 'primary'
    }
    if (inLegacy.has(sid) || (await has(legacy, sid))) {
      inLegacy.add(sid)
      return 'legacy'
    }
    throw new StoreSessionNotFound(sid)
  }
  /** Перед записью: старая сессия → перенос (один на id, параллельные ждут его). */
  async function writable(sid: string): Promise<void> {
    // Мемо ставится до первого await: параллельные записи ждут один перенос.
    let p = migrating.get(sid)
    if (!p) {
      p = (async () => {
        if ((await where(sid)) === 'primary') return
        const r = await migrateSession(legacy, primary, sid, { ...(opts.warn ? { warn: opts.warn } : {}) })
        inPrimary.add(sid)
        inLegacy.delete(sid)
        opts.onMigrate?.(r)
      })().finally(() => migrating.delete(sid))
      migrating.set(sid, p)
    }
    return p
  }
  const pick = async (sid: string): Promise<ExtendedSessionStore> => ((await where(sid)) === 'primary' ? primary : legacy)

  const store: ExtendedSessionStore = {
    capabilities: () => primary.capabilities(),
    async list(o) {
      const [a, b] = await Promise.all([primary.list(), legacy.list().catch(() => ({ sessions: [] as SessionInfo[] }))])
      const ids = new Set(a.sessions.map((s) => s.id))
      const all = [...a.sessions, ...b.sessions.filter((s) => !ids.has(s.id))]
      all.sort((x, y) => (y.updatedAt ?? '').localeCompare(x.updatedAt ?? ''))
      const page = paginate(all, o)
      return page.cursor !== undefined ? { sessions: page.items, cursor: page.cursor } : { sessions: page.items }
    },
    async load(sid) {
      // Сразу основной: не нашли — старый (ошибку чтения основного не глотаем).
      if (inPrimary.has(sid) || !inLegacy.has(sid)) {
        try {
          const m = await primary.load(sid)
          inPrimary.add(sid)
          return m
        } catch (err) {
          if (!isNotFound(err)) throw err
          inPrimary.delete(sid)
        }
      }
      const m = await legacy.load(sid)
      inLegacy.add(sid)
      return m
    },
    async create(o) {
      const info = await primary.create(o)
      inPrimary.add(info.id)
      return info
    },
    async appendNode(sid, node) {
      await writable(sid)
      return primary.appendNode(sid, node)
    },
  }
  if (primary.delete) {
    store.delete = async (sid) => {
      if ((await where(sid)) === 'legacy') throw new Error(`nr-chat-store: сессия ${sid} — старый формат (${format}), только чтение; сначала конвертировать`)
      await primary.delete!(sid)
      inPrimary.delete(sid)
    }
  }
  const writeThrough = <K extends 'rename' | 'editNode' | 'deleteNode' | 'hideNode' | 'setActiveLeaf'>(k: K): void => {
    const fn = primary[k] as ((sid: string, ...rest: never[]) => Promise<unknown>) | undefined
    if (!fn) return
    ;(store as unknown as Record<string, unknown>)[k] = async (sid: string, ...rest: never[]) => {
      await writable(sid)
      return fn.call(primary, sid, ...rest)
    }
  }
  writeThrough('rename')
  writeThrough('editNode')
  writeThrough('deleteNode')
  writeThrough('hideNode')
  writeThrough('setActiveLeaf')
  if (primary.forkCopy) {
    store.forkCopy = async (sid, at) => {
      await writable(sid)
      const info = await primary.forkCopy!(sid, at)
      inPrimary.add(info.id)
      return info
    }
  }
  if (primary.meta) {
    store.meta = {
      async get(sid) {
        if ((await where(sid)) === 'primary') return primary.meta!.get(sid)
        return { ...((await legacy.meta?.get(sid)) ?? {}), [LEGACY_FORMAT_KEY]: format }
      },
      async patch(sid, p) {
        const { [LEGACY_FORMAT_KEY]: _l, ...rest } = p
        await writable(sid)
        if (Object.keys(rest).length) await primary.meta!.patch(sid, rest)
      },
      ...(primary.meta.set
        ? {
            async set(sid: string, doc: Record<string, unknown>) {
              const { [LEGACY_FORMAT_KEY]: _l, ...rest } = doc
              await writable(sid)
              await primary.meta!.set!(sid, rest)
            },
          }
        : {}),
    }
  }
  if (primary.assets) {
    store.assets = {
      async put(sid, name, data, mime) {
        await writable(sid)
        return primary.assets!.put(sid, name, data, mime)
      },
      ...(primary.assets.get
        ? {
            async get(sid: string, ref: string) {
              const s = await pick(sid)
              if (!s.assets?.get) throw new StoreSessionNotFound(sid)
              return s.assets.get(sid, ref)
            },
          }
        : {}),
    }
  }
  if (primary.version) {
    store.version = async (sid) => {
      const s = await pick(sid)
      return s.version ? s.version(sid) : ''
    }
  }
  if (primary.choices) {
    store.choices = {
      get: async (sid) => ((await pick(sid)).choices?.get(sid) ?? {}),
      async set(sid, c) {
        await writable(sid)
        await primary.choices!.set(sid, c)
      },
    }
  }
  if (primary.personas) {
    store.personas = {
      get: async (sid) => ((await pick(sid)).personas?.get(sid) ?? { personas: [] }),
      async set(sid, doc) {
        await writable(sid)
        await primary.personas!.set(sid, doc)
      },
    }
  }
  if (primary.recipes) {
    const r = primary.recipes
    store.recipes = {
      async put(sid, data, texts) {
        await writable(sid)
        await r.put(sid, data, texts)
      },
      get: async (sid, mid) => (await pick(sid)).recipes?.get(sid, mid),
      ...(r.effective
        ? {
            effective: {
              get: async (sid: string) => ((await where(sid)) === 'primary' ? r.effective!.get(sid) : undefined),
              async set(sid: string, mds: string) {
                await writable(sid)
                await r.effective!.set(sid, mds)
              },
            },
          }
        : {}),
    }
  }
  if (primary.compaction) {
    store.compaction = {
      async append(sid, input) {
        await writable(sid)
        return primary.compaction!.append(sid, input)
      },
    }
  }
  if (primary.close || legacy.close) {
    store.close = async () => {
      await primary.close?.()
      await legacy.close?.()
    }
  }
  return store
}

function isNotFound(err: unknown): boolean {
  return err instanceof StoreSessionNotFound || (err as { code?: unknown })?.code === 'not_found'
}

async function has(s: SessionStore, sid: string): Promise<boolean> {
  try {
    await s.load(sid)
    return true
  } catch (err) {
    // Чужая ошибка чтения (битый файл) — сессия есть, пусть её покажет load.
    return !isNotFound(err)
  }
}

export type { NodePatch }
