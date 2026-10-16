// Задача сессии (task-session-spec §8, протокол v1.36): хост задач пишет
// `sessionMeta.task` патчем меты, стор отдаёт `SessionInfo.task`.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createNrChatStore } from '../src/nr-chat/index.js'
import { taskOf } from '../src/nr-chat/protocol.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('nr-chat: task', () => {
  it('meta.patch {task} → list и load отдают SessionInfo.task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nrcs-task-'))
    dirs.push(dir)
    const store = createNrChatStore({ dir })
    const a = await store.create({})
    await store.meta!.patch(a.id, { task: { issue: 'DEV-7', role: 'executor', parent: 'trunk-1' } })
    const ia = (await store.list()).sessions.find((s) => s.id === a.id)!
    expect(ia.task).toEqual({ issue: 'DEV-7', role: 'executor', parent: 'trunk-1' })
    expect((await store.load(a.id)).info.task?.role).toBe('executor')
  })

  it('taskOf: чужие формы — нет задачи', () => {
    expect(taskOf(undefined)).toBeUndefined()
    expect(taskOf({ issue: 'DEV-1' })).toBeUndefined()
    expect(taskOf({ issue: 'DEV-1', role: 'boss' })).toBeUndefined()
    expect(taskOf({ issue: 'DEV-1', role: 'acceptor', parent: '' })).toEqual({ issue: 'DEV-1', role: 'acceptor' })
  })
})

describe('nr-chat: task подузлом', () => {
  it('длинная мета (большой acp) — task уходит в %%task, SessionInfo.task всё равно есть', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nrcs-task2-'))
    dirs.push(dir)
    const store = createNrChatStore({ dir })
    const { writeFileSync } = await import('node:fs')
    // Так лёг живой исполнитель DEV-334: большая `acp` и `task` — подузлами шапки.
    writeFileSync(
      join(dir, 'x.mds'),
      "%meta {id: 'x1', createdAt: '2026-10-16T16:14:49.041Z', sessionMeta: {contour: 'dev'}}\n%%acp {format: 'json5'}\n{\n  cwd: '/w',\n}\n%%task {format: 'json5'}\n{\n  issue: 'DEV-8',\n  role: 'acceptor',\n  parent: 'p',\n  phase: 'review',\n}\n",
    )
    const a = { id: 'x' }
    const all = (await store.list()).sessions
    const ia = all.find((s) => s.id === a.id)!
    expect(ia.task).toEqual({ issue: 'DEV-8', role: 'acceptor', parent: 'p' })
  })
})
