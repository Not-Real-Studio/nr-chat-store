/**
 * Тег `files` со стороны хоста (session-document-spec §4.5, DEV-275): глобы
 * шаблона и их чтение. Билдер чистый — файлы читает платформа перед каждой
 * сборкой (как `%include`) и кладёт во вход `agent.files`; здесь — общий
 * для хостов кусок, чтобы backend-nr и backend-acp понимали глоб одинаково.
 *
 * Глоб: `~/…` — от домашнего каталога, относительный — от каталога шаблона;
 * `*` и `?` — внутри сегмента, `**` — через сегменты, `{a,b}` — варианты.
 * Глоб без масок — один файл; нет файла — пусто, не ошибка (файл памяти
 * профиля появляется по ходу работы).
 */

import type { TemplateFile } from './tags.js'

// Пути — POSIX-слэши, своими силами: граница builder/ не берёт даже fs/path.
const isAbsolute = (p: string): boolean => p.startsWith('/') || /^[A-Za-z]:\//.test(p)

function normalize(path: string): string {
  const p = path.replace(/\\/g, '/')
  const root = p.startsWith('/') ? '/' : (/^[A-Za-z]:\//.exec(p)?.[0] ?? '')
  const out: string[] = []
  for (const seg of p.slice(root.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else if (seg !== '..' || !root) out.push(seg)
  }
  return root + out.join('/')
}

const resolve = (dir: string, p: string): string => normalize(isAbsolute(p) ? p : `${dir}/${p}`)

/** Глобы `<{ files "…", … }>` шаблона, как написаны, без повторов. */
export function templateFileGlobs(template: string): string[] {
  const out: string[] = []
  for (const m of template.matchAll(/<\{-?\s*files\b([\s\S]*?)-?\}>/g)) {
    for (const s of m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)) {
      const glob = (s[1] ?? s[2] ?? '').replace(/\\(.)/g, '$1')
      if (glob !== '' && !out.includes(glob)) out.push(glob)
    }
  }
  return out
}

/** Чем хост читает файлы: подмножество `Fs` nr-chat-store. */
export interface TemplateFilesFs {
  readText(path: string): Promise<string | undefined>
  /** Все файлы под каталогом (рекурсивно), полные пути. */
  list(dir: string): Promise<string[]>
}

export interface ReadTemplateFilesOpts {
  /** Каталог шаблона — база относительных глобов. */
  dir: string
  /** Домашний каталог для `~/`; нет — `~` не раскрывается. */
  home?: string
  fs: TemplateFilesFs
}

const MAGIC = /[*?[{]/

/** Глоб → абсолютный путь-шаблон. */
export function globPath(glob: string, opts: { dir: string; home?: string }): string {
  if ((glob === '~' || glob.startsWith('~/')) && opts.home) return normalize(opts.home + glob.slice(1))
  return isAbsolute(glob) ? normalize(glob) : resolve(opts.dir, glob)
}

/** Регэксп полного пути по глобу. */
export function globRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` — ноль и больше каталогов; `**` в конце — всё ниже.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      const end = pattern.indexOf('}', i)
      if (end < 0) {
        re += '\\{'
        continue
      }
      re += `(?:${pattern
        .slice(i + 1, end)
        .split(',')
        .map((alt) => alt.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'))
        .join('|')})`
      i = end
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * Прочитать файлы глобов шаблона → `agent.files` входа билдера. Ключ — глоб как
 * написан, файлы — по возрастанию пути, путь — абсолютный.
 */
export async function readTemplateFiles(template: string, opts: ReadTemplateFilesOpts): Promise<Record<string, TemplateFile[]>> {
  const out: Record<string, TemplateFile[]> = {}
  for (const glob of templateFileGlobs(template)) {
    const pattern = globPath(glob, opts)
    const files: TemplateFile[] = []
    if (!MAGIC.test(pattern)) {
      const text = await opts.fs.readText(pattern).catch(() => undefined)
      if (text !== undefined) files.push({ path: pattern, text })
    } else {
      const segs = pattern.split('/')
      const fixed: string[] = []
      for (const s of segs) {
        if (MAGIC.test(s)) break
        fixed.push(s)
      }
      const base = fixed.join('/') || '/'
      const re = globRegExp(pattern)
      const listed = await opts.fs.list(base).catch(() => [] as string[])
      for (const path of listed.map(normalize).filter((p) => re.test(p)).sort()) {
        const text = await opts.fs.readText(path).catch(() => undefined)
        if (text !== undefined) files.push({ path, text })
      }
    }
    out[glob] = files
  }
  return out
}
