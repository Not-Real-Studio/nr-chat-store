/**
 * pi driver (`./pi`) — the middle of the capability range (spec §7.2).
 *
 * JSONL v3, line-surgery: edit = line replacement, append = appending a line,
 * tree by id/parentId. Active leaf = last line (setActiveLeaf = reordering,
 * siblings are not lost). Signatures of edited content are dropped. Format
 * version pinned in opts + a smoke test on drift (NOT-237 pattern).
 *
 * Storage — a directory of pi session `.jsonl` files (recursive scan). Other
 * on-disk forms of the same entries (pi-nr's `.mds`, the `pi/2` profile of
 * pi-session-mds) plug in as `codecs` — the driver stays format-agnostic and
 * does not depend on the codec package.
 */

import type { IFileSystem, KvStore } from '@notrealstudio/nr-contracts'
import { defaultFileSystem } from '../fs/default.js'
import { fsOf, type Fs } from '../fs/facade.js'
import { basename, dirname, join, relative, resolve } from '../fs/path.js'
import { randomUUID, sha256Hex } from '../fs/sha256.js'
import type { NodeInput, ProfileDoc, SessionInfo, SessionModel, StoreNode } from '../model.js'
import {
  StoreAssetNotFound,
  StoreConflictError,
  StoreNodeNotFound,
  StoreSessionNotFound,
  assertSafeId,
  paginate,
  partsOf,
  mergeMeta,
  replaceTextParts,
  type NodePatch,
  type SessionStore,
  type StoreCapabilities,
} from '../store.js'
import { contentHash } from '../tree.js'
import type { CompactionData } from '../assembly/engine.js'
import {
  HIDDEN_CUSTOM_TYPE,
  PI_SESSION_VERSION,
  entryId,
  newSessionHeader,
  parseSessionFile,
  sessionFileName,
  serializeSessionFile,
  uuidv7,
  type PiAgentMessage,
  type PiEntry,
  type PiMessageEntry,
  type PiSessionFile,
  type PiSessionHeader,
} from './format.js'
import { applyParts, partsToMessage, toModel } from './codec.js'
import { buildTree, moveToEnd } from './tree-ops.js'
import { hasSidechannel, readSidechannel, setSidechannelFlags, setSidechannelMeta, setSidechannelParts, writeSidechannel } from '../fidelity.js'

export interface PiStoreOpts {
  /** Directory of pi `.jsonl` sessions. */
  dir: string
  /** cwd for the header of new sessions (pi groups by it). Default — `dir`. */
  cwd?: string
  /** Expected pi format version; a mismatch — warn (§7.2, NOT-237 pattern). */
  pinVersion?: number
  warn?: (message: string) => void
  /**
   * Extra file forms of pi sessions, chosen by extension (`.jsonl` is built in).
   * A codec sees the whole file: `decode` → header first, then entries in file
   * order; `encode` — the reverse. E.g. pi-session-mds:
   * `{ ext: '.mds', decode: decodeEntries, encode: encodeEntries }`.
   */
  codecs?: PiFileCodec[]
  /** Extension of NEW sessions (create/fork): `.jsonl` (default) or a codec's `ext`. */
  newSessionExt?: string
  /**
   * Make written messages continuable by pi itself: `timestamp` (ms) on every
   * message; on assistant messages `api`/`provider` from here, `model` and
   * `usage` from node meta, `stopReason` from content (`toolUse` with tool
   * calls, `aborted` for `meta.cancelled`). Off — messages are written as before.
   */
  piMessageDefaults?: { api: string; provider: string }
  /**
   * Служебные записи pi (`model_change`, `thinking_level_change`, `session_info`,
   * `custom`, `label`…) не проецировать в узлы — лента как у backend-pi; дети
   * такой записи подвешиваются к её родителю. Сообщения, скрытые (`mds-hidden`),
   * `compaction`/`branch_summary` остаются. Off — каждая запись узел, как раньше.
   * С опцией у драйвера есть `rename` (запись `session_info`, как `/name` pi),
   * заголовок сессии — из последней `session_info`, `meta` (запись
   * `custom`/`nr-session-meta`, как pi-ext-session-meta) и `choices` (модель —
   * `model_change`/`thinking_level_change`, профиль — `custom`/`nr-session-profile`).
   */
  piServiceEntries?: 'nodes' | 'hide'
  /**
   * Индекс метаданных сессий на диске для холодного `list()`: `true` —
   * `<dir>/.index.json`, строка — свой путь. Запись: путь файла → mtime, size,
   * id, `SessionInfo`; на старте `list()` перечитывает только файлы, у которых
   * mtime/size разошлись с индексом. Off (default) — кэш только в памяти.
   * `{kv, key?}` (DEV-226) — индекс в kv хоста (ключ — `pi/index/<dir>`), не файлом.
   */
  listIndex?: boolean | string | { kv: KvStore; key?: string }
  /**
   * Носитель файлов (DEV-226): OPFS/IndexedDB в браузере, память в тестах.
   * Нет — Node-носитель `./node-fs` (прежнее поведение), модуль грузится лениво.
   */
  storage?: IFileSystem
}

/** A non-JSONL file form of pi session entries (see `PiStoreOpts.codecs`). */
export interface PiFileCodec {
  /** Extension with the dot, e.g. `.mds`. */
  ext: string
  decode(text: string): unknown[]
  encode(entries: unknown[]): string
}

/** Выбор модели сессии в нативной форме pi (`model_change` + `thinking_level_change`). */
export interface PiModelChoice {
  /** `provider` записи `model_change`; нет — поле в записи не пишется. */
  provider?: string
  /** `modelId` записи `model_change`. */
  model: string
  /** `thinkingLevel` последней `thinking_level_change` по активной ветке. */
  thinking?: string
}

/** Выбор сессии, переживающий рестарт бэкенда: модель и профиль. */
export interface PiSessionChoices {
  model?: PiModelChoice
  /** Профиль: `data.name` записи `nr-session-profile`; встроенный профиль (`data.doc`) — `'inline'`. */
  profile?: string
  /** Документ встроенного профиля (`profile: 'inline'`) — `data.doc` записи; переживает рестарт. */
  profileDoc?: ProfileDoc
}

/**
 * Хранение выбора модели/профиля в самой сессии (только `piServiceEntries: 'hide'`).
 * Чтение — последние записи по АКТИВНОЙ ветке (выбор ветвится вместе с историей);
 * запись — дописать ребёнком текущего листа то, что изменилось (одинаковое не пишется).
 */
export interface PiChoicesApi {
  get(sid: string): Promise<PiSessionChoices>
  set(sid: string, choices: PiSessionChoices): Promise<void>
}

/** Узел компакции для {@link PiCompactionApi.append}: тело записи `compaction` pi. */
export interface PiCompactionInput extends CompactionData {
  /** Usage вызова резюме — поле `usage` записи (pi пишет `Usage` провайдера). */
  usage?: { input: number; output: number }
  /** Родитель записи; нет — текущий лист (последняя запись файла), как у pi. */
  parent?: string
}

/**
 * Запись компакции в нативной форме pi (`type: 'compaction'`, её же пишет
 * `appendCompaction` pi): pi открывает такую сессию и собирает контекст от неё.
 */
export interface PiCompactionApi {
  append(sid: string, input: PiCompactionInput): Promise<StoreNode>
}

/**
 * Персоны сессии в нативной форме (personas-spec §1): `custom`/`nr-session-personas`,
 * в `data` — полный документ `{personas, userId?}`; текущий — последний по
 * активной ветке. Формат — общий с backend-pi, forge и pi-ext-session-meta.
 */
export interface PiPersonasApi {
  get(sid: string): Promise<{ personas: unknown[]; userId?: string }>
  set(sid: string, doc: { personas: unknown[]; userId?: string }): Promise<void>
}

/**
 * Рецепт промпта ответа (prompt-recipe-spec §3): `custom`/`nr-prompt-recipe`
 * `{forMessageId, ...рецепт}` — ребёнком текущего листа (после ответа, как
 * pi-ext на `agent_end`), тексты кусков — `<файл сессии>.prompts/<hash>.md`
 * (один раз на хэш). Тот же формат читает backend-pi: сессия, которую вёл nr,
 * открывает рецепты и в pi, и наоборот.
 */
export interface PiRecipesApi {
  put(sid: string, data: Record<string, unknown> & { forMessageId: string }, texts: ReadonlyMap<string, string>): Promise<void>
  /** Последний рецепт ответа `messageId` (в любой ветке) и тексты его кусков; нет — `undefined`. */
  get(sid: string, messageId: string): Promise<{ data: Record<string, unknown>; texts: Map<string, string> } | undefined>
}

/** `SessionStore` pi-драйвера: контракт + необязательные расширения `choices`, `compaction`, `personas`, `recipes`. */
export type PiSessionStore = SessionStore & { choices?: PiChoicesApi; compaction?: PiCompactionApi; personas?: PiPersonasApi; recipes?: PiRecipesApi }

/** customType документа меты — общий с pi-ext-session-meta и backend-pi. */
export const SESSION_META_CUSTOM_TYPE = 'nr-session-meta'
/** customType записи профиля сессии — общий с backend-pi. */
export const SESSION_PROFILE_CUSTOM_TYPE = 'nr-session-profile'
/** customType документа персон — общий с backend-pi/forge/pi-ext (`PERSONAS_CUSTOM_TYPE` протокола). */
export const SESSION_PERSONAS_CUSTOM_TYPE = 'nr-session-personas'
/** customType рецепта промпта — общий с pi-ext/backend-pi (`PROMPT_RECIPE_CUSTOM_TYPE` протокола). */
export const PROMPT_RECIPE_CUSTOM_TYPE = 'nr-prompt-recipe'
/** Каталог текстов рецептов: суффикс к полному имени файла сессии (как pi-ext). */
export const PROMPTS_DIR_SUFFIX = '.prompts'

const CAPABILITIES: StoreCapabilities = {
  edits: { edit: true, delete: true, hide: true },
  swipes: true,
  fork: true,
}

/** Записи pi, которые остаются узлами при `piServiceEntries: 'hide'`. */
const CONTENT_ENTRY_TYPES = new Set(['message', 'compaction', 'branch_summary'])

export function createPiStore(opts: PiStoreOpts): PiSessionStore {
  const { dir } = opts
  const cwd = opts.cwd ?? dir
  const warn = opts.warn ?? ((m: string) => console.warn(m))
  const fsReady: Promise<Fs> = (opts.storage ? Promise.resolve(opts.storage) : defaultFileSystem()).then(fsOf)
  const codecs = opts.codecs ?? []
  const newExt = opts.newSessionExt ?? JSONL_EXT
  if (newExt !== JSONL_EXT && !codecs.some((c) => c.ext === newExt)) {
    throw new Error(`nr-chat-store/pi: newSessionExt ${newExt} has no codec`)
  }

  const hideService = opts.piServiceEntries === 'hide'

  /**
   * `SessionInfo` файла без проекции узлов — ровно `project(file, sid).info`
   * (list() зовёт его на каждый файл, полная проекция там не нужна).
   */
  function summarize(file: PiSessionFile, sid: string): SessionInfo {
    const info: SessionInfo = { id: sid, createdAt: file.header.timestamp, messageCount: file.entries.length }
    if (!hideService) return info
    const kept = keptIds(file.entries)
    let count = 0
    let title: string | undefined
    for (const e of file.entries) {
      if (kept.has(e.id)) count++
      if (e.type === 'session_info' && typeof (e as { name?: unknown }).name === 'string') title = (e as unknown as { name: string }).name
    }
    info.messageCount = count
    if (title) info.title = title
    // RP-1b: бот сессии — первая char-персона (имя и ref аватара), как у backend-pi.
    const char = readPersonasDoc(activeBranch(file.entries)).personas.find((p) => isPlainRecord(p) && p.kind === 'char') as { name?: unknown; avatar?: unknown } | undefined
    if (char && typeof char.name === 'string' && char.name !== '') {
      info.botName = char.name
      if (typeof char.avatar === 'string' && char.avatar !== '') info.botAvatar = char.avatar
    }
    return info
  }

  /** Проекция файла в модель: все записи — или без служебных (`piServiceEntries`). */
  function project(file: PiSessionFile, sid: string): SessionModel {
    const model = toModel(file, sid)
    if (!hideService) return model
    const kept = keptIds(file.entries)
    const parentOf = new Map<string, string | null>()
    for (const e of file.entries) parentOf.set(e.id, e.parentId ?? null)
    const resolve = (id: string | null): string | null => {
      let cur = id
      const seen = new Set<string>()
      while (cur !== null && !kept.has(cur) && !seen.has(cur)) {
        seen.add(cur)
        cur = parentOf.get(cur) ?? null
      }
      return cur !== null && kept.has(cur) ? cur : null
    }
    // Кто сказал ответ — `personaId` рецепта (правило backend-pi `answerPersonas`):
    // в записи сообщения pi места под него нет.
    const speakers = answerPersonas(file.entries)
    const nodes = model.nodes
      .filter((n) => kept.has(n.id))
      .map((n) => {
        const node = { ...n, parent: resolve(n.parent) }
        const who = n.role === 'assistant' ? speakers.get(n.id) : undefined
        if (who !== undefined && node.meta?.personaId === undefined) node.meta = { ...(node.meta ?? {}), personaId: who }
        return node
      })
    // Сиблинги — по времени записи, как у pi (getTree) и backend-pi: порядок
    // файла переставляет сам свайп (moveToEnd), и номер ветки уезжал бы после
    // каждого (forge: активный гритинг 1/5 читался как 5/5). Лист — явно:
    // последняя строка файла, поднятая до узла ленты.
    const at = new Map(file.entries.map((e) => [e.id, String((e as { timestamp?: unknown }).timestamp ?? '')]))
    const order = new Map(nodes.map((n, i) => [n.id, i]))
    nodes.sort((a, b) => (at.get(a.id) ?? '').localeCompare(at.get(b.id) ?? '') || order.get(a.id)! - order.get(b.id)!)
    const last = file.entries.length ? resolve(file.entries[file.entries.length - 1]!.id) : null
    return { info: summarize(file, sid), nodes, ...(last !== null ? { meta: { activeLeaf: last } } : {}) }
  }

  function codecOf(path: string): PiFileCodec | undefined {
    return codecs.find((c) => path.endsWith(c.ext))
  }

  function isSessionFile(name: string): boolean {
    return name.endsWith(JSONL_EXT) || codecOf(name) !== undefined
  }

  /** File text → parsed file: JSONL by line surgery, codec files whole. */
  function parse(path: string, text: string): PiSessionFile {
    const codec = codecOf(path)
    if (!codec) return parseSessionFile(text)
    const [header, ...entries] = codec.decode(text) as [PiSessionHeader, ...PiEntry[]]
    if (!header || header.type !== 'session' || typeof header.id !== 'string') {
      throw new Error(`nr-chat-store/pi: ${path}: no pi session header`)
    }
    return { header, entries }
  }

  function serialize(path: string, file: PiSessionFile): string {
    const codec = codecOf(path)
    return codec ? codec.encode([file.header, ...file.entries]) : serializeSessionFile(file)
  }

  function fileName(id: string, timestamp: string): string {
    return sessionFileName(id, timestamp).slice(0, -JSONL_EXT.length) + newExt
  }

  /**
   * Файлы сессий каталога (рекурсивно), в порядке обхода. Без разбора и без
   * stat на каждый файл: тип — из `Dirent` (stat — только у симлинков).
   */
  async function sessionFiles(): Promise<string[]> {
    const fs = await fsReady
    const out: string[] = []
    const walk = async (root: string): Promise<void> => {
      let items
      try {
        items = await fs.readdir(root)
      } catch {
        return
      }
      for (const d of items ?? []) {
        const full = join(root, d.name)
        if (d.type === 'dir') await walk(full)
        else if (isSessionFile(d.name)) out.push(full)
      }
    }
    await walk(dir)
    return out
  }

  /**
   * Кэш файлов сессий по (путь, mtimeMs, size): id из заголовка и `SessionInfo`
   * (без `updatedAt`). Перечитывается только изменившийся файл; собственная
   * запись кладёт сюда id и сбрасывает info (разрешение mtime не подведёт).
   */
  interface CachedFile {
    mtimeMs: number
    size: number
    /** id из заголовка; нет — файл битый. */
    id?: string
    info?: SessionInfo
  }
  const fileCache = new Map<string, CachedFile>()

  // Индекс на диске (listIndex): кэш файлов переживает рестарт процесса.
  const indexKv = typeof opts.listIndex === 'object' ? opts.listIndex : undefined
  const indexKvKey = indexKv ? (indexKv.key ?? `pi/index/${dir.replace(/[^A-Za-z0-9._-]+/g, '_')}`) : ''
  const indexPath = indexKv ? undefined : opts.listIndex ? (typeof opts.listIndex === 'string' ? opts.listIndex : join(dir, LIST_INDEX_FILE)) : undefined
  let indexLoaded = false
  /** Сериализованный вид кэша на момент последнего чтения/записи индекса. */
  let indexSnapshot = ''

  async function loadIndex(): Promise<void> {
    if (indexLoaded || (!indexPath && !indexKv)) return
    indexLoaded = true
    let raw: unknown
    try {
      if (indexKv) {
        const got = await indexKv.kv.get(indexKvKey)
        raw = got.ok ? got.value : undefined
        if (!raw) return
      } else raw = JSON.parse((await (await fsReady).readText(indexPath!)) ?? '')
    } catch {
      return
    }
    const files = (raw as { version?: unknown; files?: unknown } | null)?.files
    if ((raw as { version?: unknown }).version !== LIST_INDEX_VERSION || typeof files !== 'object' || files === null) return
    const base = resolve(dir)
    for (const [rel, v] of Object.entries(files as Record<string, unknown>)) {
      const e = v as Partial<CachedFile> | null
      if (!e || typeof e.mtimeMs !== 'number' || typeof e.size !== 'number') continue
      const path = join(base, rel)
      if (fileCache.has(path)) continue
      const entry: CachedFile = { mtimeMs: e.mtimeMs, size: e.size }
      if (typeof e.id === 'string') entry.id = e.id
      if (e.info && typeof e.info === 'object' && typeof (e.info as SessionInfo).id === 'string') entry.info = e.info as SessionInfo
      fileCache.set(path, entry)
    }
    indexSnapshot = serializeIndex()
  }

  function serializeIndex(): string {
    const base = resolve(dir)
    const files: Record<string, CachedFile> = {}
    for (const [path, e] of [...fileCache.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      // Без сводки — файл ещё не разобран для list(): в индекс не идёт.
      if (e.id !== undefined && !e.info) continue
      files[relative(base, path)] = e
    }
    return JSON.stringify({ version: LIST_INDEX_VERSION, files })
  }

  /** Записать индекс, если кэш изменился (атомарно: tmp + rename). Сбой записи — не ошибка list(). */
  async function saveIndex(): Promise<void> {
    if (!indexPath && !indexKv) return
    const text = serializeIndex()
    if (text === indexSnapshot) return
    if (indexKv) {
      const r = await indexKv.kv.set(indexKvKey, JSON.parse(text))
      if (r.ok) indexSnapshot = text
      return
    }
    try {
      const fs = await fsReady
      const tmp = `${indexPath!}.${randomUUID().slice(0, 8)}.tmp`
      await fs.writeText(tmp, text)
      await fs.rename(tmp, indexPath!)
      indexSnapshot = text
    } catch {
      /* read-only каталог — живём на кэше в памяти */
    }
  }

  /** Запись кэша файла: при промахе — разбор (заголовок + сводка). `undefined` — файла нет. */
  async function cachedFile(path: string, needInfo: boolean): Promise<CachedFile | undefined> {
    const fs = await fsReady
    const st = await fs.stat(path).catch(() => undefined)
    if (!st || st.type !== 'file') {
      fileCache.delete(path)
      return undefined
    }
    const hit = fileCache.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && (hit.id === undefined || hit.info || !needInfo)) return hit
    const entry: CachedFile = { mtimeMs: st.mtimeMs, size: st.size }
    try {
      const file = parse(path, (await fs.readText(path)) ?? '')
      checkVersion(file)
      entry.id = file.header.id
      entry.info = summarize(file, file.header.id)
    } catch {
      /* broken file — skip */
    }
    fileCache.set(path, entry)
    return entry
  }

  /** После своей записи: id известен, сводка будет пересчитана при следующем list(). */
  async function noteWritten(path: string, id: string): Promise<void> {
    const st = await (await fsReady).stat(path).catch(() => undefined)
    if (st) fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, id })
    else fileCache.delete(path)
  }

  /** id сессии в файле — из кэша, при промахе — разбор. */
  async function idAt(path: string): Promise<string | undefined> {
    return (await cachedFile(path, false))?.id
  }

  /**
   * Индекс каталога: id (из заголовка) → путь, как прежний полный скан (при
   * повторе id побеждает файл, встреченный позже). `pace` — отдать event loop
   * между файлами при долгом холодном разборе.
   */
  async function indexAll(pace: boolean): Promise<Map<string, { path: string; entry: CachedFile }>> {
    await loadIndex()
    const found = new Map<string, { path: string; entry: CachedFile }>()
    const files = await sessionFiles()
    let slice = Date.now()
    for (const path of files) {
      const entry = await cachedFile(path, true)
      if (entry?.id !== undefined) found.set(entry.id, { path, entry })
      if (pace && Date.now() - slice > 20) {
        await new Promise((r) => setTimeout(r, 0))
        slice = Date.now()
      }
    }
    // Исчезнувшие файлы — из кэша вон.
    const alive = new Set(files)
    for (const path of fileCache.keys()) if (!alive.has(path)) fileCache.delete(path)
    await saveIndex()
    return found
  }

  /** Полный индекс id → путь (запасной путь {@link pathOf}). */
  async function scan(): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    for (const path of await sessionFiles()) {
      const id = await idAt(path)
      if (id !== undefined) found.set(id, path)
    }
    return found
  }

  let warnedVersion = false
  function checkVersion(file: PiSessionFile): void {
    const pin = opts.pinVersion
    const ver = file.header.version ?? 1
    if (pin !== undefined && ver !== pin && !warnedVersion) {
      warnedVersion = true
      warn(`nr-chat-store/pi: format version ${ver} != pinVersion ${pin} — possible spec drift`)
    }
  }

  /** Путь сессии по id, разобранной в последний раз (быстрый путь {@link pathOf}). */
  const known = new Map<string, string>()

  /**
   * Файл сессии по id. Быстрый путь — имя файла: pi кладёт id в него
   * (`<время>_<id>.<ext>`), проверяется только заголовок найденного файла.
   * Полный скан (разбор каждого файла) — запасной: на сотнях сессий он
   * синхронно держит event loop секундами, а зовётся на каждой операции.
   */
  async function pathOf(id: string): Promise<string> {
    assertSafeId(id, 'session id')
    const cached = known.get(id)
    if (cached && (await idAt(cached)) === id) return cached
    for (const path of await filesNamed(id)) {
      if ((await idAt(path)) === id) {
        known.set(id, path)
        return path
      }
    }
    const path = (await scan()).get(id)
    if (!path) throw new StoreSessionNotFound(id)
    known.set(id, path)
    return path
  }

  /** Файлы сессий, в имени которых стоит `_<id>.` — без разбора содержимого. */
  async function filesNamed(id: string): Promise<string[]> {
    const needle = `_${id}.`
    return (await sessionFiles()).filter((path) => basename(path).includes(needle))
  }

  async function read(id: string): Promise<{ path: string; file: PiSessionFile }> {
    const path = await pathOf(id)
    const text = await (await fsReady).readText(path)
    if (text === undefined) throw new StoreSessionNotFound(id)
    return { path, file: parse(path, text) }
  }

  async function write(path: string, file: PiSessionFile): Promise<void> {
    await (await fsReady).writeText(path, serialize(path, file))
    await noteWritten(path, file.header.id)
  }

  function requireEntry(file: PiSessionFile, nid: string): PiEntry {
    const entry = file.entries.find((e) => e.id === nid)
    if (!entry) throw new StoreNodeNotFound(nid)
    return entry
  }

  function returnNode(file: PiSessionFile, sid: string, nid: string): StoreNode {
    const node = project(file, sid).nodes.find((n) => n.id === nid)
    if (!node) throw new StoreNodeNotFound(nid)
    return node
  }

  const store: PiSessionStore = {
    async capabilities(): Promise<StoreCapabilities> {
      return CAPABILITIES
    },

    async list(opts): Promise<{ sessions: SessionInfo[]; cursor?: string }> {
      const sessions: SessionInfo[] = []
      for (const [sid, { path, entry }] of await indexAll(true)) {
        if (!entry.info) continue
        known.set(sid, path)
        sessions.push({ ...entry.info, updatedAt: new Date(entry.mtimeMs).toISOString() })
      }
      sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
      const page = paginate(sessions, opts)
      return page.cursor !== undefined ? { sessions: page.items, cursor: page.cursor } : { sessions: page.items }
    },

    async load(id: string): Promise<SessionModel> {
      const { file } = await read(id)
      return project(file, id)
    },

    async create(createOpts): Promise<SessionInfo> {
      const now = new Date()
      const timestamp = now.toISOString()
      const id = createOpts?.id !== undefined ? assertSafeId(createOpts.id, 'session id') : uuidv7(now.getTime())
      const path = join(dir, fileName(id, timestamp))
      const header = newSessionHeader(id, cwd, timestamp)
      const file: PiSessionFile = { header, entries: [] }
      await write(path, file)
      const info: SessionInfo = { id, createdAt: timestamp, messageCount: 0 }
      if (createOpts?.info?.title) info.title = createOpts.info.title
      return info
    },

    async delete(id: string): Promise<void> {
      const path = await pathOf(id)
      await (await fsReady).remove(path)
      fileCache.delete(path)
      known.delete(id)
    },

    async appendNode(sid: string, node: NodeInput): Promise<StoreNode> {
      const { path, file } = await read(sid)
      const taken = new Set(file.entries.map((e) => e.id))
      const parentId =
        node.parent !== undefined
          ? hideService
            ? attachPoint(file.entries, node.parent)
            : node.parent
          : file.entries.length
            ? file.entries[file.entries.length - 1].id
            : null

      // id-first (§2): honor NodeInput.id verbatim (+assertSafeId, +duplicate
      // reject); pi stops generating its own when an id is given.
      let id: string
      if (node.id !== undefined) {
        id = assertSafeId(node.id, 'node id')
        if (taken.has(id)) throw new Error(`nr-chat-store/pi: node id ${JSON.stringify(id)} already exists in session ${sid}`)
      } else {
        id = entryId(taken)
      }

      const parts = partsOf(node)
      const message = partsToMessage(node.role, node.name, parts)
      if (opts.piMessageDefaults) withPiDefaults(message, parts, node.meta, opts.piMessageDefaults)
      let entry: PiEntry = {
        type: 'message',
        id,
        parentId: parentId ?? null,
        timestamp: new Date().toISOString(),
        message,
      }
      // Fidelity (§3): park the whole neutral node so every Part/flag/meta
      // survives, even what pi can't express natively. Native content is written
      // above for pi's own tooling; the sidechannel is authoritative on our read.
      writeSidechannel(entry as unknown as Record<string, unknown>, node.role, parts, node.flags, node.meta, node.name)
      if (node.flags?.disabled || node.flags?.hidden) entry = wrapHidden(entry as PiMessageEntry)

      const next = { ...file, entries: [...file.entries, entry] }
      await write(path, next)
      return returnNode(next, sid, entry.id)
    },

    async editNode(sid: string, nid: string, patch: NodePatch): Promise<StoreNode> {
      const { path, file } = await read(sid)
      const current = returnNode(file, sid, nid)
      if (patch.ifHash !== undefined && contentHash(current.role, current.parts) !== patch.ifHash) {
        throw new StoreConflictError(nid)
      }
      const parts = patch.parts ?? (patch.text !== undefined ? replaceTextParts(current.parts, patch.text) : undefined)
      if (!parts && patch.meta === undefined) throw new Error('nr-chat-store/pi: editNode — parts, text or meta required')

      const entry = requireEntry(file, nid)
      const edited = parts ? editEntry(entry, parts, current.role) : ({ ...entry } as PiEntry)
      // Keep the fidelity sidechannel (§3) in sync — otherwise a stale copy would
      // shadow the edit on the next load.
      if (parts) setSidechannelParts(edited as unknown as Record<string, unknown>, parts)
      // Meta (step tags, DEV-231): pi has no native place for it — sidechannel only;
      // a foreign record without one gets the whole node parked there.
      if (patch.meta !== undefined) {
        const rec = edited as unknown as Record<string, unknown>
        const meta = mergeMeta(current.meta, patch.meta)
        if (hasSidechannel(rec)) setSidechannelMeta(rec, meta)
        else writeSidechannel(rec, current.role, parts ?? current.parts, current.flags, meta, current.name)
      }
      const next = replaceEntry(file, edited)
      await write(path, next)
      return returnNode(next, sid, nid)
    },

    async deleteNode(sid: string, nid: string): Promise<void> {
      const { path, file } = await read(sid)
      const target = requireEntry(file, nid)
      const entries = file.entries
        .filter((e) => e.id !== nid)
        .map((e) => (e.parentId === nid ? ({ ...e, parentId: target.parentId } as PiEntry) : e))
      await write(path, { ...file, entries })
    },

    async hideNode(sid: string, nid: string, hidden: boolean): Promise<void> {
      const { path, file } = await read(sid)
      const entry = requireEntry(file, nid)
      const isHidden =
        entry.type === 'custom' && (entry as { customType?: string }).customType === HIDDEN_CUSTOM_TYPE
      if (hidden === isHidden) return

      let next: PiEntry
      if (hidden) {
        if (entry.type !== 'message') {
          throw new Error(`nr-chat-store/pi: entry ${nid} of type "${entry.type}" can't be hidden`)
        }
        next = wrapHidden(entry as PiMessageEntry)
      } else {
        next = unwrapHidden(entry)
      }
      // Sync the fidelity sidechannel flags (§3) so the sidechannel (authoritative
      // on read) agrees with the native mds-hidden wrapper.
      const rec = next as unknown as Record<string, unknown>
      const sc = readSidechannel(rec)
      if (sc) {
        const flags = { ...(sc.flags ?? {}) }
        if (hidden) flags.disabled = true
        else { delete flags.disabled; delete flags.hidden }
        setSidechannelFlags(rec, flags)
      }
      await write(path, replaceEntry(file, next))
    },

    async setActiveLeaf(sid: string, nid: string): Promise<void> {
      const { path, file } = await read(sid)
      requireEntry(file, nid)
      // В режиме hide служебные записи под узлом (мета, выбор модели, профиль)
      // едут в конец вместе с ним: свайпнул назад — вернулась и мета ветки.
      const entries = hideService ? moveToEndWithService(file.entries, nid) : moveToEnd(file.entries, nid)
      await write(path, { ...file, entries })
    },

    async forkCopy(sid: string, atNodeId?: string): Promise<SessionInfo> {
      const { file } = await read(sid)
      const tree = buildTree(file.entries)
      const leafId = atNodeId ?? tree.leafId
      if (!leafId) throw new Error(`nr-chat-store/pi: session ${sid} is empty — nothing to fork`)
      if (!tree.byId.has(leafId)) throw new StoreNodeNotFound(leafId)

      const path: PiEntry[] = []
      for (let node = tree.byId.get(leafId) ?? null; node; node = node.parent) path.unshift(node.entry)

      const now = new Date()
      const timestamp = now.toISOString()
      const newId = uuidv7(now.getTime())
      const dst = join(dir, fileName(newId, timestamp))
      const header = { ...newSessionHeader(newId, file.header.cwd, timestamp), parentSession: sid }
      await write(dst, { header, entries: path })

      const info: SessionInfo = { id: newId, createdAt: timestamp, parentSessionId: sid, messageCount: path.length }
      if (atNodeId) info.forkMessageId = atNodeId
      return info
    },

    async version(sid: string): Promise<string> {
      const { path } = await read(sid)
      const data = await (await fsReady).readBytes(path)
      if (!data) throw new StoreSessionNotFound(sid)
      return sha256Hex(data).slice(0, 16)
    },
  }

  /**
   * Дописать служебные записи цепочкой ребёнком текущего листа (последней
   * записи), как pi `appendEntry`: каждая следующая — ребёнок предыдущей.
   */
  async function appendService(sid: string, bodies: Array<Record<string, unknown>>): Promise<void> {
    if (!bodies.length) return
    const { path, file } = await read(sid)
    const taken = new Set(file.entries.map((e) => e.id))
    let parentId = file.entries.length ? file.entries[file.entries.length - 1]!.id : null
    const added: PiEntry[] = []
    for (const { type, ...body } of bodies) {
      const id = entryId(taken)
      taken.add(id)
      added.push({ type, id, parentId, timestamp: new Date().toISOString(), ...body } as PiEntry)
      parentId = id
    }
    await write(path, { ...file, entries: [...file.entries, ...added] })
  }

  /** Записи активной ветки (корень → лист) файла сессии. */
  async function branchOf(sid: string): Promise<PiEntry[]> {
    return activeBranch((await read(sid)).file.entries)
  }

  // Компакция — содержательная запись (узел ленты в обоих режимах), формат pi.
  store.compaction = {
    async append(sid, input) {
      const { path, file } = await read(sid)
      const taken = new Set(file.entries.map((e) => e.id))
      const parentId = input.parent !== undefined ? input.parent : file.entries.length ? file.entries[file.entries.length - 1]!.id : null
      if (parentId !== null) requireEntry(file, parentId)
      const id = entryId(taken)
      const entry: Record<string, unknown> = {
        type: 'compaction',
        id,
        parentId,
        timestamp: new Date().toISOString(),
        summary: input.summary,
        firstKeptEntryId: input.firstKeptEntryId,
        tokensBefore: input.tokensBefore,
      }
      if (input.details !== undefined) entry.details = input.details
      if (input.usage) {
        const { input: i, output: o } = input.usage
        entry.usage = { input: i, output: o, cacheRead: 0, cacheWrite: 0, totalTokens: i + o, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      }
      if (input.fromHook) entry.fromHook = true
      const next = { ...file, entries: [...file.entries, entry as unknown as PiEntry] }
      await write(path, next)
      return returnNode(next, sid, id)
    },
  }

  // rename, meta, choices — служебные записи ребёнком последней записи (как pi);
  // только когда служебные записи скрыты, иначе они всплыли бы узлами в ленте.
  if (hideService) {
    store.rename = async (sid: string, title: string): Promise<void> => {
      await appendService(sid, [{ type: 'session_info', name: title }])
    }

    // Формат — pi-ext-session-meta / backend-pi: `custom`/`nr-session-meta`,
    // в `data` полный документ; текущий — последний по активной ветке.
    const getMeta = async (sid: string): Promise<Record<string, unknown>> => readMetaDoc(await branchOf(sid))
    const setMeta = (sid: string, doc: Record<string, unknown>): Promise<void> =>
      appendService(sid, [{ type: 'custom', customType: SESSION_META_CUSTOM_TYPE, data: doc }])
    store.meta = {
      async get(sid) {
        return getMeta(sid)
      },
      async set(sid, doc) {
        await setMeta(sid, doc)
      },
      async patch(sid, p) {
        await setMeta(sid, { ...(await getMeta(sid)), ...p })
      },
    }

    store.choices = {
      async get(sid) {
        return readChoices(await branchOf(sid))
      },
      async set(sid, want) {
        const cur = readChoices(await branchOf(sid))
        const bodies: Array<Record<string, unknown>> = []
        if (want.model) {
          const { provider, model, thinking } = want.model
          if (model !== cur.model?.model || provider !== cur.model?.provider) {
            bodies.push(provider === undefined ? { type: 'model_change', modelId: model } : { type: 'model_change', provider, modelId: model })
          }
          if (thinking !== undefined && thinking !== cur.model?.thinking) {
            bodies.push({ type: 'thinking_level_change', thinkingLevel: thinking })
          }
        }
        if (want.profile === 'inline' && want.profileDoc) {
          // Встроенный профиль — документом (формат backend-pi): одинаковый не пишется.
          const { id: _id, ...doc } = want.profileDoc
          if (JSON.stringify(doc) !== JSON.stringify(cur.profileDoc ? (({ id: _i, ...d }) => d)(cur.profileDoc) : undefined)) {
            bodies.push({ type: 'custom', customType: SESSION_PROFILE_CUSTOM_TYPE, data: { doc } })
          }
        } else if (want.profile !== undefined && want.profile !== 'inline' && want.profile !== cur.profile) {
          bodies.push({ type: 'custom', customType: SESSION_PROFILE_CUSTOM_TYPE, data: { name: want.profile } })
        }
        await appendService(sid, bodies)
      },
    }

    store.personas = {
      async get(sid) {
        return readPersonasDoc(await branchOf(sid))
      },
      async set(sid, doc) {
        const data: Record<string, unknown> = { personas: doc.personas }
        if (doc.userId !== undefined) data.userId = doc.userId
        await appendService(sid, [{ type: 'custom', customType: SESSION_PERSONAS_CUSTOM_TYPE, data }])
      },
    }

    store.recipes = {
      async put(sid, data, texts) {
        const path = await pathOf(sid)
        // Тексты — до записи: рецепт без текстов панель показала бы пустым.
        try {
          const fs = await fsReady
          const dir = path + PROMPTS_DIR_SUFFIX
          for (const [hash, text] of texts) {
            assertSafeId(hash, 'prompt hash')
            const file = join(dir, `${hash}.md`)
            if (!(await fs.exists(file))) await fs.writeText(file, text)
          }
        } catch (err) {
          warn(`nr-chat-store/pi: тексты рецепта ${sid} не записаны — ${err instanceof Error ? err.message : String(err)}`)
        }
        await appendService(sid, [{ type: 'custom', customType: PROMPT_RECIPE_CUSTOM_TYPE, data }])
      },
      async get(sid, messageId) {
        const { path, file } = await read(sid)
        let data: Record<string, unknown> | undefined
        for (const e of file.entries) {
          const c = e as { customType?: unknown; data?: unknown }
          if (e.type === 'custom' && c.customType === PROMPT_RECIPE_CUSTOM_TYPE && isPlainRecord(c.data) && c.data.forMessageId === messageId) data = c.data
        }
        if (!data) return undefined
        const hashes = new Set<string>()
        if (typeof data.systemHash === 'string') hashes.add(data.systemHash)
        for (const list of [data.injections, data.systemBlocks]) {
          if (Array.isArray(list)) for (const i of list) if (isPlainRecord(i) && typeof i.hash === 'string') hashes.add(i.hash)
        }
        const texts = new Map<string, string>()
        const fs = await fsReady
        for (const hash of hashes) {
          const file = join(path + PROMPTS_DIR_SUFFIX, `${hash}.md`)
          try {
            const text = /^[0-9a-f]+$/i.test(hash) ? await fs.readText(file) : undefined
            if (text !== undefined) texts.set(hash, text)
          } catch {
            // Нет текста — кусок покажется пустым.
          }
        }
        return { data, texts }
      },
    }

    // Вложения — `<каталог>/<session-id>.files/<ref>`, как backend-pi (attachments-spec §3):
    // ref — `<sha256[:12]>-<имя>`, файл один на байты. Аватары forge/play там же.
    store.assets = {
      async put(sid, name, data) {
        const path = await pathOf(sid)
        if (!name || name.startsWith('.') || basename(name) !== name || /[\\\x00-\x1f]/.test(name)) throw new Error(`nr-chat-store/pi: имя вложения «${name}» — не имя файла`)
        const ref = `${sha256Hex(data).slice(0, 12)}-${name}`
        const fs = await fsReady
        const file = join(dirname(path), `${sid}.files`, ref)
        if (!(await fs.exists(file))) await fs.writeBytes(file, data)
        return { ref }
      },
      async get(sid, ref) {
        const path = await pathOf(sid)
        if (typeof ref !== 'string' || ref === '' || ref.startsWith('.') || basename(ref) !== ref || /[\\\x00-\x1f]/.test(ref)) throw new StoreAssetNotFound(ref)
        const data = await (await fsReady).readBytes(join(dirname(path), `${sid}.files`, ref)).catch(() => undefined)
        if (!data) throw new StoreAssetNotFound(ref)
        return { data }
      },
    }

    store.capabilities = async () => ({ ...CAPABILITIES, rename: true, sessionMeta: true, assets: true })
  }

  return store
}

// ── entry helpers ──────────────────────────────────────────────────────────────

/**
 * Узлы ленты при `piServiceEntries: 'hide'`: содержательные записи и скрытые
 * сообщения. Маркер `/nr-continue` pi-ext (user-сообщение с `nrContinue: true`)
 * — служебный: реплики в нём не было (backend-pi его тоже прячет).
 */
function isVisibleEntry(e: PiEntry): boolean {
  if (e.type === 'message' && (e as { message?: { role?: unknown; nrContinue?: unknown } }).message?.nrContinue === true) return false
  return CONTENT_ENTRY_TYPES.has(e.type) || (e.type === 'custom' && (e as { customType?: string }).customType === HIDDEN_CUSTOM_TYPE)
}

/** `forMessageId` → `personaId` рецептов файла (любой ветки); последний побеждает. */
function answerPersonas(entries: PiEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of entries) {
    const c = e as { customType?: unknown; data?: { forMessageId?: unknown; personaId?: unknown } }
    if (e.type !== 'custom' || c.customType !== PROMPT_RECIPE_CUSTOM_TYPE) continue
    if (typeof c.data?.forMessageId === 'string' && typeof c.data.personaId === 'string') out.set(c.data.forMessageId, c.data.personaId)
  }
  return out
}

function keptIds(entries: PiEntry[]): Set<string> {
  const kept = new Set<string>()
  for (const e of entries) if (isVisibleEntry(e)) kept.add(e.id)
  return kept
}

/**
 * Куда в файле вешать узел с явным родителем ленты (режим hide): служебные
 * записи (персоны, мета) под родителем на активной ветке остаются на пути —
 * узел ложится под последнюю из них, а не рядом. Иначе свайп первого ответа
 * (родитель ленты — `null`, в файле — запись персон) отрывал ветку от персон и
 * меты (DEV-235).
 */
function attachPoint(entries: PiEntry[], parent: string | null): string | null {
  const branch = activeBranch(entries)
  const kept = keptIds(entries)
  let i = parent === null ? -1 : branch.findIndex((e) => e.id === parent)
  if (parent !== null && i < 0) return parent
  let at = parent
  for (i++; i < branch.length && !kept.has(branch[i]!.id); i++) at = branch[i]!.id
  return at
}

/** Активная ветка: от листа (последней записи) к корню, развёрнутая корень → лист. */
function activeBranch(entries: PiEntry[]): PiEntry[] {
  const tree = buildTree(entries)
  const path: PiEntry[] = []
  const seen = new Set<string>()
  for (let node = tree.leafId !== null ? tree.byId.get(tree.leafId) ?? null : null; node && !seen.has(node.entry.id); node = node.parent) {
    seen.add(node.entry.id)
    path.push(node.entry)
  }
  return path.reverse()
}

/**
 * `moveToEnd` для режима hide: узел становится листом вместе со служебными
 * потомками, до которых можно дойти, не проходя через узлы ленты. Лист pi —
 * последняя из них (в порядке файла), так мета/выбор ветки снова на активном пути.
 */
function moveToEndWithService(entries: PiEntry[], nid: string): PiEntry[] {
  const tree = buildTree(entries)
  const target = tree.byId.get(nid)
  if (!target) return entries
  const carry = new Set<string>()
  const stack = [...target.children]
  while (stack.length) {
    const node = stack.pop()!
    if (isVisibleEntry(node.entry) || node.entry.id === nid || carry.has(node.entry.id)) continue
    carry.add(node.entry.id)
    stack.push(...node.children)
  }
  const tail = entries.filter((e) => carry.has(e.id))
  return [...entries.filter((e) => e.id !== nid && !carry.has(e.id)), target.entry, ...tail]
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Документ меты: последняя `nr-session-meta` ветки с `data`-объектом; нет — `{}`. */
function readMetaDoc(branch: PiEntry[]): Record<string, unknown> {
  let doc: Record<string, unknown> = {}
  for (const e of branch) {
    const c = e as { customType?: unknown; data?: unknown }
    if (e.type === 'custom' && c.customType === SESSION_META_CUSTOM_TYPE && isPlainRecord(c.data)) doc = c.data
  }
  return doc
}

/** Документ персон: последняя `nr-session-personas` ветки с массивом `personas`; нет — пустой. */
function readPersonasDoc(branch: PiEntry[]): { personas: unknown[]; userId?: string } {
  let doc: { personas: unknown[]; userId?: string } = { personas: [] }
  for (const e of branch) {
    const c = e as { customType?: unknown; data?: unknown }
    if (e.type !== 'custom' || c.customType !== SESSION_PERSONAS_CUSTOM_TYPE || !isPlainRecord(c.data) || !Array.isArray(c.data.personas)) continue
    doc = { personas: c.data.personas }
    if (typeof c.data.userId === 'string') doc.userId = c.data.userId
  }
  return doc
}

/** Модель/профиль ветки — как читают pi (`model_change`, `thinking_level_change`) и backend-pi (профиль). */
function readChoices(branch: PiEntry[]): PiSessionChoices {
  let model: PiModelChoice | undefined
  let thinking: string | undefined
  let profile: string | undefined
  let profileDoc: ProfileDoc | undefined
  for (const e of branch) {
    const r = e as Record<string, unknown>
    if (e.type === 'model_change' && typeof r.modelId === 'string') {
      model = typeof r.provider === 'string' ? { provider: r.provider, model: r.modelId } : { model: r.modelId }
    } else if (e.type === 'thinking_level_change' && typeof r.thinkingLevel === 'string') {
      thinking = r.thinkingLevel
    } else if (e.type === 'custom' && r.customType === SESSION_PROFILE_CUSTOM_TYPE) {
      const data = r.data as { name?: unknown; doc?: unknown } | null | undefined
      if (isPlainRecord(data?.doc) && typeof data.doc.name === 'string') {
        profile = 'inline'
        profileDoc = { ...(data.doc as unknown as ProfileDoc), id: 'inline' }
      } else if (typeof data?.name === 'string' && data.name !== '') {
        profile = data.name
        profileDoc = undefined
      }
    }
  }
  const out: PiSessionChoices = {}
  if (model) out.model = thinking !== undefined ? { ...model, thinking } : model
  if (profile !== undefined) out.profile = profile
  if (profileDoc) out.profileDoc = profileDoc
  return out
}

const JSONL_EXT = '.jsonl'

/** Имя индекса метаданных по умолчанию (`listIndex: true`): не сессия — расширение не `.jsonl`/кодека. */
export const LIST_INDEX_FILE = '.index.json'
const LIST_INDEX_VERSION = 2

/** `PiStoreOpts.piMessageDefaults`: fields pi needs to continue a session we wrote. */
function withPiDefaults(
  message: PiAgentMessage,
  parts: import('../model.js').Part[],
  meta: Record<string, unknown> | undefined,
  defaults: { api: string; provider: string },
): void {
  const m = message as Record<string, unknown>
  if (m.timestamp === undefined) m.timestamp = Date.now()
  if (message.role !== 'assistant') return
  if (m.api === undefined) m.api = defaults.api
  if (m.provider === undefined) m.provider = defaults.provider
  if (m.model === undefined) m.model = typeof meta?.model === 'string' ? meta.model : 'unknown'
  if (m.usage === undefined) {
    const u = (meta?.usage ?? {}) as { input?: unknown; output?: unknown }
    const input = typeof u.input === 'number' ? u.input : 0
    const output = typeof u.output === 'number' ? u.output : 0
    m.usage = {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }
  }
  if (m.stopReason === undefined) {
    m.stopReason = meta?.cancelled === true ? 'aborted' : parts.some((p) => p.type === 'tool_use') ? 'toolUse' : 'stop'
  }
}

function replaceEntry(file: PiSessionFile, next: PiEntry): PiSessionFile {
  return { ...file, entries: file.entries.map((e) => (e.id === next.id ? next : e)) }
}

/** Replace the content of a message entry (or a wrapped hidden one) with new parts. */
function editEntry(entry: PiEntry, parts: import('../model.js').Part[], role: string): PiEntry {
  if (entry.type === 'custom' && (entry as { customType?: string }).customType === HIDDEN_CUSTOM_TYPE) {
    const wrapper = entry as PiEntry & { data?: { message?: PiAgentMessage } }
    const inner = wrapper.data?.message
    if (!inner) throw new Error(`nr-chat-store/pi: entry ${entry.id} contains no hidden message`)
    const nextInner = partsToMessage(role, undefined, parts)
    return { ...wrapper, data: { ...wrapper.data, message: { ...inner, ...nextInner } } } as PiEntry
  }
  if (entry.type !== 'message') {
    throw new Error(`nr-chat-store/pi: entry ${entry.id} of type "${entry.type}" is not editable`)
  }
  return applyParts(entry as PiMessageEntry, parts)
}

function wrapHidden(entry: PiMessageEntry): PiEntry {
  const { message, ...chain } = entry
  return { ...chain, type: 'custom', customType: HIDDEN_CUSTOM_TYPE, data: { message } } as unknown as PiEntry
}

function unwrapHidden(entry: PiEntry): PiEntry {
  const wrapper = entry as PiEntry & { data?: { message?: PiAgentMessage }; customType?: string }
  const inner = wrapper.data?.message
  if (!inner) throw new Error(`nr-chat-store/pi: entry ${entry.id} contains no hidden message`)
  const { customType: _c, data: _d, ...chain } = wrapper
  return { ...chain, type: 'message', message: inner } as unknown as PiEntry
}
