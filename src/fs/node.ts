/**
 * `IFileSystem` над `node:fs` (DEV-226) — носитель Node-хоста и драйверов
 * сессий по умолчанию. Пути — как есть (абсолютные или от cwd процесса).
 * Единственный модуль пакета с `node:*` вне `claude`/`lore-files`.
 */

import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { err, ok, type DirEntry, type IFileSystem, type Result } from '@notrealstudio/nr-contracts'

function isMissing(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

async function attempt<T>(fn: () => Promise<T>, missing?: () => T): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (e) {
    if (missing && isMissing(e)) return ok(missing())
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}

export function createNodeFileSystem(): IFileSystem {
  const self: IFileSystem = {
    read: (p) => attempt(() => readFile(p, 'utf-8') as Promise<string | undefined>, () => undefined),
    async write(p, content) {
      return attempt(async () => {
        await mkdir(dirname(p), { recursive: true })
        await writeFile(p, content, 'utf-8')
      })
    },
    exists: (p) => attempt(() => stat(p).then(() => true), () => false),
    list: (prefix) =>
      attempt(async () => {
        const out: string[] = []
        const walk = async (d: string): Promise<void> => {
          let items
          try {
            items = await readdir(d, { withFileTypes: true })
          } catch (e) {
            if (isMissing(e)) return
            throw e
          }
          for (const it of items) {
            const full = join(d, it.name)
            let isDir = it.isDirectory()
            if (it.isSymbolicLink()) isDir = (await stat(full).catch(() => undefined))?.isDirectory() ?? false
            if (isDir) await walk(full)
            else out.push(full.split('\\').join('/'))
          }
        }
        await walk(prefix)
        return out.sort()
      }),
    delete: (p) => attempt(() => unlink(p), () => undefined),
    stat: (p) =>
      attempt(
        async () => {
          const st = await stat(p)
          return { type: st.isDirectory() ? ('dir' as const) : ('file' as const), size: st.size, mtimeMs: st.mtimeMs }
        },
        () => undefined,
      ),
    readBytes: (p) =>
      attempt(
        async () => {
          const b = await readFile(p)
          return new Uint8Array(b.buffer, b.byteOffset, b.byteLength) as Uint8Array | undefined
        },
        () => undefined,
      ),
    async writeBytes(p, data) {
      return attempt(async () => {
        await mkdir(dirname(p), { recursive: true })
        await writeFile(p, data)
      })
    },
    readdir: (p) =>
      attempt(
        async () => {
          const items = await readdir(p, { withFileTypes: true })
          const out: DirEntry[] = []
          for (const it of items) {
            let isDir = it.isDirectory()
            if (it.isSymbolicLink()) isDir = (await stat(join(p, it.name)).catch(() => undefined))?.isDirectory() ?? false
            out.push({ name: it.name, type: isDir ? 'dir' : 'file' })
          }
          return out as DirEntry[] | undefined
        },
        () => undefined,
      ),
    mkdir: (p) => attempt(async () => void (await mkdir(p, { recursive: true }))),
    rename: (a, b) =>
      attempt(async () => {
        await mkdir(dirname(b), { recursive: true })
        await rename(a, b)
      }),
    remove: (p, opts) => attempt(() => rm(p, { recursive: opts?.recursive === true, force: true })),
    realpath: (p) => attempt(() => realpath(p)),
    append: (p, content) =>
      attempt(async () => {
        await mkdir(dirname(p), { recursive: true })
        await appendFile(p, content, 'utf-8')
      }),
  }
  return self
}
