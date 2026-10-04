/**
 * @notrealstudio/nr-chat-store/lore-files — лорбук профиля с диска (RP-1c):
 * `$lorebook`, `$lorebook_budget`, `$lorebook_scan_card` профиля → книги для
 * `assembleRp` (`ProfileLore`). Один код на оба бэкенда (DEV-224): backend-nr
 * читает атрибуты из `ProfileDoc.extra`, pi-ext — из флагов расширения, которые
 * хост форвардит из того же профиля.
 *
 * Отдельный сабпат, а не `assembly`: там IO запрещено (boundary-тест).
 *
 * `$lorebook` — пути списком (`a.json, b.json`, `$[a, b]` или JSON-массив),
 * относительные — от `base` (папка профилей), `~/` — домашняя. Файлы читаются
 * на ран с кэшем по mtime (правка книги видна со следующего хода); битый или
 * пропавший — предупреждение, ран идёт без него. Формат — CCv3 (книга или
 * карточка) или ST world info (`lorebookOf`).
 */

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { lorebookOf, type Lorebook } from './assembly/lorebook.js'
import type { ProfileLore } from './assembly/assemble-rp.js'

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

/** Путь `$lorebook` → абсолютный: `~/` — домашняя, относительный — от `base`. */
export function resolveLorePath(p: string, base: string | undefined): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  if (isAbsolute(p)) return p
  return resolve(base ?? process.cwd(), p)
}

const cache = new Map<string, { mtimeMs: number; book: Lorebook | undefined }>()

/** Книга из файла; нет или не книга — `undefined` и предупреждение. */
export function loadLorebookFile(path: string, warn: (m: string) => void = () => {}): Lorebook | undefined {
  try {
    const { mtimeMs } = statSync(path)
    const hit = cache.get(path)
    if (hit && hit.mtimeMs === mtimeMs) return hit.book
    const book = lorebookOf(JSON.parse(readFileSync(path, 'utf-8')))
    if (!book) warn(`${path} — не лорбук (ни CCv3, ни world info)`)
    cache.set(path, { mtimeMs, book })
    return book
  } catch (err) {
    warn(`лорбук профиля ${path} не прочитан — ${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/** Лорбук профиля рана: книги прочитаны, бюджет и скан — из профиля. */
export function loadProfileLore(profile: unknown, base: string | undefined, warn?: (m: string) => void): ProfileLore {
  const cfg = profileLoreConfig(profile)
  const books = cfg.paths.map((p) => loadLorebookFile(resolveLorePath(p, base), warn)).filter((b): b is Lorebook => b !== undefined)
  return { books, scanCard: cfg.scanCard, ...(cfg.budget !== undefined ? { budget: cfg.budget } : {}) }
}
