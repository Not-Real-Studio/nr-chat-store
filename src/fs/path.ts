/**
 * Пути без `node:path` (DEV-226): прямой слеш контракта `IStorage`, абсолютный
 * путь — `/…` или диск Windows `C:/…` (обратные слеши приводятся к прямым).
 * Семантика — как у `path.posix`; относительный путь в `resolve` остаётся
 * относительным (рабочего каталога процесса у ядра нет).
 */

export const sep = '/'

export function toSlash(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Корень пути: `/`, `C:/` или `''` (относительный). */
function rootOf(p: string): string {
  if (p.startsWith('/')) return '/'
  const m = /^([A-Za-z]:)(\/|$)/.exec(p)
  return m ? `${m[1]}/` : ''
}

export function isAbsolute(p: string): boolean {
  return rootOf(toSlash(p)) !== ''
}

export function normalize(path: string): string {
  const p = toSlash(path)
  const root = rootOf(p)
  const out: string[] = []
  for (const seg of p.slice(root.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!root) out.push('..')
      continue
    }
    out.push(seg)
  }
  const body = out.join('/')
  if (root) return root + body
  return body || '.'
}

export function join(...parts: string[]): string {
  const kept = parts.filter((s) => s !== '')
  return kept.length ? normalize(kept.join('/')) : '.'
}

/** Справа налево до первого абсолютного; нет абсолютного — относительный результат. */
export function resolve(...parts: string[]): string {
  const acc: string[] = []
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = toSlash(parts[i]!)
    if (p === '') continue
    acc.unshift(p)
    if (isAbsolute(p)) break
  }
  return acc.length ? normalize(acc.join('/')) : '.'
}

export function dirname(path: string): string {
  const p = normalize(path)
  const root = rootOf(p)
  if (p === root) return p
  const i = p.lastIndexOf('/')
  if (i < 0) return '.'
  if (i < root.length) return root
  return p.slice(0, i)
}

export function basename(path: string, ext?: string): string {
  const p = normalize(path)
  const root = rootOf(p)
  if (p === root) return ''
  const name = p.slice(p.lastIndexOf('/') + 1)
  return ext && name.endsWith(ext) && name !== ext ? name.slice(0, -ext.length) : name
}

/** Путь `to` относительно `from` (оба в одной форме); разные корни — `to` как есть. */
export function relative(from: string, to: string): string {
  const a = normalize(from)
  const b = normalize(to)
  if (rootOf(a).toLowerCase() !== rootOf(b).toLowerCase()) return b
  const ra = rootOf(a)
  const sa = a.slice(ra.length).split('/').filter((s) => s && s !== '.')
  const sb = b.slice(ra.length).split('/').filter((s) => s && s !== '.')
  let i = 0
  while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++
  return [...sa.slice(i).map(() => '..'), ...sb.slice(i)].join('/')
}

/** `target` внутри `base` (или совпадает). */
export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
