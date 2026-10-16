/**
 * Файл-кэш индекса списка сессий (DEV-344): `KvStore` в памяти процесса, который
 * переживает рестарт — JSON рядом с каталогом сессий, через носитель стора
 * (без `node:*`: драйвер живёт и в браузере). Битый или чужой файл — пустой индекс, кэш пересоберётся.
 */
import { err, ok, type KvStore } from '@notrealstudio/nr-contracts'
import type { Fs } from '../fs/facade.js'
import { randomUUID } from '../fs/sha256.js'

const SAVE_DELAY_MS = 200

export function createFileIndexKv(path: string, fsReady: Promise<Fs>): KvStore {
  let data: Map<string, unknown> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let writing: Promise<void> = Promise.resolve()

  async function load(): Promise<Map<string, unknown>> {
    if (data) return data
    data = new Map()
    try {
      const raw = JSON.parse((await (await fsReady).readText(path)) ?? 'null') as unknown
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [k, v] of Object.entries(raw)) data.set(k, v)
    } catch {
      /* нет файла или битый — холодный старт */
    }
    return data
  }

  async function flush(): Promise<void> {
    timer = undefined
    const snapshot = JSON.stringify(Object.fromEntries(data ?? []))
    writing = writing.then(async () => {
      try {
        const fs = await fsReady
        const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`
        await fs.writeText(tmp, snapshot)
        await fs.rename(tmp, path)
      } catch {
        /* кэш — не источник правды: не записался, пересоберётся */
      }
    })
    await writing
  }

  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(() => void flush(), SAVE_DELAY_MS)
    timer.unref?.()
  }

  return {
    async get<T>(key: string) {
      return ok((await load()).get(key) as T | undefined)
    },
    async set(key, value) {
      if (value === undefined) return err(new Error(`kv: undefined под ключом ${key}`))
      ;(await load()).set(key, value)
      schedule()
      return ok(undefined)
    },
    async delete(key) {
      ;(await load()).delete(key)
      schedule()
      return ok(undefined)
    },
    async list(prefix) {
      return ok([...(await load()).keys()].filter((k) => k.startsWith(prefix)).sort())
    },
  }
}
