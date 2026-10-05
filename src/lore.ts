/**
 * @notrealstudio/nr-chat-store/lore — лорбук профиля над `IFileSystem` хоста
 * (DEV-226): то же, что `./lore-files`, но без `node:*` — backend-nr в
 * браузере и Worker'е читает книги профиля через свой носитель.
 *
 * Кэш книг — по (путь, mtime) в памяти процесса: потеря безвредна (перечтение).
 */

import type { IFileSystem } from '@notrealstudio/nr-contracts'
import { lorebookOf, type Lorebook } from './assembly/lorebook.js'
import type { ProfileLore } from './assembly/assemble-rp.js'
import { fsOf } from './fs/facade.js'
import { isAbsolute, join, resolve } from './fs/path.js'

export interface ProfileLoreConfig {
  paths: string[]
  budget?: number
  scanCard: boolean
}

/** Значение атрибута профиля: из поля или из `extra` (текст mdz). */
function attr(profile: unknown, key: string): unknown {
  const p = (profile ?? {}) as Record<string, unknown> & { extra?: Record<string, unknown> }
  return p[key] ?? p.extra?.[key]
}

/** Список путей: массив, JSON-массив строкой, `$[a, b]` или `a, b`. */
function pathList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string') return []
  const text = raw.trim()
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return parsed.map(String)
    } catch {
      // не JSON — разбор списком ниже
    }
  }
  return text.replace(/^\$?\[/, '').replace(/\]$/, '').split(',')
}

/** `$lorebook*` профиля → пути (как написаны), бюджет, флаг скана карточки. */
export function profileLoreConfig(profile: unknown): ProfileLoreConfig {
  const paths = pathList(attr(profile, 'lorebook'))
    .map((p) => p.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  const scan = attr(profile, 'lorebook_scan_card')
  const out: ProfileLoreConfig = { paths, scanCard: scan === true || /^\s*(true|1|yes)\s*$/i.test(String(scan ?? '')) }
  const budget = Number(attr(profile, 'lorebook_budget'))
  if (Number.isFinite(budget) && budget > 0) out.budget = budget
  return out
}

/** Путь `$lorebook` → абсолютный: `~/` — `home`, относительный — от `base`. */
export function resolveLorePathIn(p: string, base: string | undefined, home?: string): string {
  if (home && p === '~') return home
  if (home && p.startsWith('~/')) return join(home, p.slice(2))
  if (isAbsolute(p)) return p
  return base ? resolve(base, p) : p
}

const cache = new Map<string, { mtimeMs: number; book: Lorebook | undefined }>()

/** Книга из файла носителя; нет или не книга — `undefined` и предупреждение. */
export async function readLorebookFile(storage: IFileSystem, path: string, warn: (m: string) => void = () => {}): Promise<Lorebook | undefined> {
  const fs = fsOf(storage)
  try {
    const st = await fs.stat(path)
    if (!st) throw new Error('файла нет')
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === st.mtimeMs && st.mtimeMs !== 0) return hit.book
    const book = lorebookOf(JSON.parse((await fs.readText(path)) ?? ''))
    if (!book) warn(`${path} — не лорбук (ни CCv3, ни world info)`)
    cache.set(path, { mtimeMs: st.mtimeMs, book })
    return book
  } catch (err) {
    warn(`лорбук профиля ${path} не прочитан — ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** Лорбук профиля рана над носителем хоста: книги, бюджет и скан — из профиля. */
export async function readProfileLore(
  storage: IFileSystem,
  profile: unknown,
  base: string | undefined,
  opts: { warn?: (m: string) => void; home?: string } = {},
): Promise<ProfileLore> {
  const cfg = profileLoreConfig(profile)
  const books: Lorebook[] = []
  for (const p of cfg.paths) {
    const book = await readLorebookFile(storage, resolveLorePathIn(p, base, opts.home), opts.warn)
    if (book) books.push(book)
  }
  return { books, scanCard: cfg.scanCard, ...(cfg.budget !== undefined ? { budget: cfg.budget } : {}) }
}
