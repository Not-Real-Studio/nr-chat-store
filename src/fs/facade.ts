/**
 * Обёртка `IFileSystem` для кода, которому удобнее исключения, чем `Result`
 * (драйверы, тулы): `err` носителя → throw, «нет такого» → `undefined`.
 */

import type { DirEntry, FileStat, IFileSystem, Result } from '@notrealstudio/nr-contracts'
import { dirname } from './path.js'

export interface Fs {
  readonly raw: IFileSystem
  readText(path: string): Promise<string | undefined>
  writeText(path: string, text: string): Promise<void>
  readBytes(path: string): Promise<Uint8Array | undefined>
  writeBytes(path: string, data: Uint8Array): Promise<void>
  stat(path: string): Promise<FileStat | undefined>
  exists(path: string): Promise<boolean>
  readdir(path: string): Promise<DirEntry[] | undefined>
  mkdir(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>
  /** Все файлы под каталогом (рекурсивно), полные пути. */
  list(prefix: string): Promise<string[]>
  /** Канонический путь; носитель без симлинков — путь как есть. */
  realpath(path: string): Promise<string>
  append(path: string, text: string): Promise<void>
  /** Копия каталога (рекурсивно). */
  copyDir(from: string, to: string): Promise<void>
}

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw r.error
  return r.value
}

export function fsOf(fs: IFileSystem): Fs {
  const out: Fs = {
    raw: fs,
    readText: async (p) => unwrap(await fs.read(p)),
    writeText: async (p, t) => unwrap(await fs.write(p, t)),
    readBytes: async (p) => unwrap(await fs.readBytes(p)),
    writeBytes: async (p, d) => unwrap(await fs.writeBytes(p, d)),
    stat: async (p) => unwrap(await fs.stat(p)),
    exists: async (p) => unwrap(await fs.exists(p)),
    readdir: async (p) => unwrap(await fs.readdir(p)),
    mkdir: async (p) => unwrap(await fs.mkdir(p)),
    rename: async (a, b) => unwrap(await fs.rename(a, b)),
    remove: async (p, o) => unwrap(await fs.remove(p, o)),
    list: async (p) => unwrap(await fs.list(p)),
    realpath: async (p) => (fs.realpath ? unwrap(await fs.realpath(p)) : p),
    async append(p, t) {
      if (fs.append) return unwrap(await fs.append(p, t))
      const prev = unwrap(await fs.read(p)) ?? ''
      unwrap(await fs.write(p, prev + t))
    },
    async copyDir(from, to) {
      const entries = unwrap(await fs.readdir(from))
      if (!entries) return
      unwrap(await fs.mkdir(to))
      for (const e of entries) {
        const a = `${from}/${e.name}`
        const b = `${to}/${e.name}`
        if (e.type === 'dir') await out.copyDir(a, b)
        else {
          const data = unwrap(await fs.readBytes(a))
          if (data) {
            unwrap(await fs.mkdir(dirname(b)))
            unwrap(await fs.writeBytes(b, data))
          }
        }
      }
    },
  }
  return out
}
