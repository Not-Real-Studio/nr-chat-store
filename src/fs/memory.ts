/**
 * `IFileSystem` в памяти (DEV-226): тесты ядра без диска, хост `memory`,
 * запасной носитель браузера. Пути нормализуются (`/a/./b` ≡ `/a/b`),
 * относительный — от `/`. Время изменения монотонно растёт (кэши по mtime
 * видят каждую запись).
 */

import { err, ok, type DirEntry, type FileStat, type IFileSystem } from '@notrealstudio/nr-contracts'
import { dirname, isAbsolute, normalize } from './path.js'

type Node = { type: 'file'; data: Uint8Array; mtimeMs: number } | { type: 'dir'; mtimeMs: number }

export interface MemoryFileSystem extends IFileSystem {
  /** Снимок: путь → текст (UTF-8) — для проверок в тестах. */
  dump(): Record<string, string>
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function createMemoryFileSystem(files: Record<string, string | Uint8Array> = {}): MemoryFileSystem {
  const nodes = new Map<string, Node>([['/', { type: 'dir', mtimeMs: 0 }]])
  let clock = 0
  const tick = (): number => (clock = Math.max(clock + 1, Date.now()))
  const norm = (p: string): string => {
    const n = normalize(p)
    return isAbsolute(n) ? n : normalize(`/${n}`)
  }
  const children = (dir: string): string[] => {
    const prefix = dir === '/' ? '/' : `${dir}/`
    return [...nodes.keys()].filter((k) => k !== dir && k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
  }
  const mkdirp = (dir: string): void => {
    const d = norm(dir)
    if (nodes.get(d)?.type === 'dir') return
    if (nodes.get(d)?.type === 'file') throw new Error(`EEXIST: file at ${d}`)
    const parent = dirname(d)
    if (parent !== d) mkdirp(parent)
    nodes.set(d, { type: 'dir', mtimeMs: tick() })
  }
  const put = (path: string, data: Uint8Array): void => {
    const p = norm(path)
    if (nodes.get(p)?.type === 'dir') throw new Error(`EISDIR: ${p}`)
    mkdirp(dirname(p))
    nodes.set(p, { type: 'file', data, mtimeMs: tick() })
  }
  const file = (path: string): Uint8Array | undefined => {
    const n = nodes.get(norm(path))
    return n?.type === 'file' ? n.data : undefined
  }
  const subtree = (p: string): string[] => [...nodes.keys()].filter((k) => k === p || k.startsWith(p === '/' ? '/' : `${p}/`))
  const wrap = async <T>(fn: () => T) => {
    try {
      return ok(fn())
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)))
    }
  }

  for (const [p, v] of Object.entries(files)) put(p, typeof v === 'string' ? enc.encode(v) : v)

  return {
    read: (p) => wrap(() => {
      const d = file(p)
      return d === undefined ? undefined : dec.decode(d)
    }),
    write: (p, content) => wrap(() => put(p, enc.encode(content))),
    exists: (p) => wrap(() => nodes.has(norm(p))),
    list: (prefix) => wrap(() => {
      const p = norm(prefix)
      return subtree(p).filter((k) => nodes.get(k)!.type === 'file').sort()
    }),
    delete: (p) => wrap(() => {
      if (nodes.get(norm(p))?.type === 'file') nodes.delete(norm(p))
    }),
    stat: (p) => wrap((): FileStat | undefined => {
      const n = nodes.get(norm(p))
      if (!n) return undefined
      return { type: n.type, size: n.type === 'file' ? n.data.length : 0, mtimeMs: n.mtimeMs }
    }),
    readBytes: (p) => wrap(() => {
      const d = file(p)
      return d === undefined ? undefined : d.slice()
    }),
    writeBytes: (p, data) => wrap(() => put(p, data.slice())),
    readdir: (p) => wrap((): DirEntry[] | undefined => {
      const d = norm(p)
      if (nodes.get(d)?.type !== 'dir') return undefined
      return children(d)
        .map((k) => ({ name: k.slice(k.lastIndexOf('/') + 1), type: nodes.get(k)!.type }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    }),
    mkdir: (p) => wrap(() => mkdirp(p)),
    rename: (from, to) => wrap(() => {
      const a = norm(from)
      const b = norm(to)
      if (!nodes.has(a)) throw new Error(`ENOENT: ${a}`)
      if (a === b) return
      mkdirp(dirname(b))
      for (const k of subtree(b)) nodes.delete(k)
      for (const k of subtree(a)) {
        const n = nodes.get(k)!
        nodes.delete(k)
        nodes.set(b + k.slice(a.length), n)
      }
    }),
    remove: (p, opts) => wrap(() => {
      const d = norm(p)
      const n = nodes.get(d)
      if (!n || d === '/') return
      if (n.type === 'dir' && children(d).length && !opts?.recursive) throw new Error(`ENOTEMPTY: ${d}`)
      for (const k of subtree(d)) nodes.delete(k)
    }),
    append: (p, content) => wrap(() => {
      const prev = file(p) ?? new Uint8Array()
      const add = enc.encode(content)
      const next = new Uint8Array(prev.length + add.length)
      next.set(prev)
      next.set(add, prev.length)
      put(p, next)
    }),
    dump() {
      const out: Record<string, string> = {}
      for (const [k, n] of [...nodes.entries()].sort(([a], [b]) => a.localeCompare(b))) if (n.type === 'file') out[k] = dec.decode(n.data)
      return out
    },
  }
}
