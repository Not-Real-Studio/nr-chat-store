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
