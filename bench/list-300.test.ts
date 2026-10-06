/**
 * Замер DEV-237 (nr-driver-switch-spec §2, §4): холодный/тёплый `list()`
 * nr-chat на 300 сессиях реального размера (без индекса и с kv-индексом),
 * `forkCopy` сессии с 1.5 МБ вложений, `appendNode` под параллельным `load`.
 * Запуск: `BENCH=1 npx vitest run bench` — в общий прогон не входит.
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'vitest'
import { createNrChatStore } from '../src/nr-chat/index.js'

const N = Number(process.env.BENCH_N ?? 300)
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} мс`

function memKv() {
  const m = new Map<string, unknown>()
  return {
    get: async <T>(k: string) => ({ ok: true as const, value: m.get(k) as T | undefined }),
    set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)),
    delete: async (k: string) => void m.delete(k),
    list: async () => [...m.keys()],
  } as never
}

it('замер list/fork/append', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-nr-'))
  const seed = createNrChatStore({ dir })
  const s = await seed.create({ info: { title: 'seed' } })
  await seed.personas!.set(s.id, { personas: [{ id: 'c', kind: 'char', name: 'C', card: { description: 'x'.repeat(8000) } }], userId: 'u' })
  for (let i = 0; i < 120; i++) await seed.appendNode(s.id, { role: i % 2 ? 'assistant' : 'user', text: 'Текст реплики. '.repeat(90) })
  const text = readFileSync(join(dir, `${s.id}.mds`), 'utf-8')
  for (let i = 0; i < N; i++) writeFileSync(join(dir, `s${i}.mds`), text.replace(`id: '${s.id}'`, `id: 's${i}'`))
  console.log(`файл ${(text.length / 1024).toFixed(0)} КБ × ${N}`)

  let t = performance.now()
  await createNrChatStore({ dir }).list()
  console.log(`list() без индекса: ${ms(t)}`)
  const kv = memKv()
  t = performance.now()
  await createNrChatStore({ dir, index: kv }).list()
  console.log(`list() с kv-индексом, первый (строит): ${ms(t)}`)
  t = performance.now()
  await createNrChatStore({ dir, index: kv }).list()
  console.log(`list() с kv-индексом, холодный процесс: ${ms(t)}`)

  // forkCopy: 1.5 МБ вложений
  const st = createNrChatStore({ dir })
  await st.assets!.put(s.id, 'big.png', new Uint8Array(1_500_000).fill(7))
  t = performance.now()
  await st.forkCopy!(s.id)
  console.log(`forkCopy (120 узлов, 1.5 МБ вложений): ${ms(t)}`)

  // appendNode под параллельным load
  let reads = 0
  let errors = 0
  let stop = false
  const reader = (async () => {
    while (!stop) {
      try {
        await st.load(s.id)
        reads++
      } catch {
        errors++
      }
    }
  })()
  t = performance.now()
  for (let i = 0; i < 30; i++) await st.appendNode(s.id, { role: 'user', text: `параллельно ${i}` })
  const appendMs = (performance.now() - t) / 30
  stop = true
  await reader
  console.log(`appendNode под параллельным load: ${appendMs.toFixed(1)} мс/запись, чтений ${reads}, ошибок чтения ${errors}`)
}, 120_000)
