/**
 * assembly-сюита (spec §8): контракт (чистота/тотальность), generic-шаги, профиль
 * v0 — включая ГОЛДЕН bit-в-bit паритет с прежним sim/lib/assemble.assemble
 * (главный регресс-критерий §5.2), и replay-заглушку §5.3.
 *
 * Голден-состав переехал из sim/test/assemble.test.ts (spec §6): те же кейсы,
 * тот же ожидаемый выход, но поверх assembleV0(nodes, {params, mode}).
 */

import { describe, expect, it } from 'vitest'
import type { StoreNode } from '../src/index.js'
import type { AssembleCtx } from '../src/assembly/index.js'
import {
  compose,
  filter,
  partition,
  sliceTail,
  relabel,
  selectV0,
  orderV0,
  trimV0,
  relabelV0,
  assembleV0,
  speaker,
} from '../src/assembly/index.js'

let seq = 0
function n(role: string, text: string, extra: Partial<StoreNode> = {}): StoreNode {
  return { id: `n${++seq}`, parent: null, role, parts: [{ type: 'text', text }], ...extra }
}
const texts = (out: StoreNode[]) => out.map((x) => (x.parts[0] as { text: string }).text)
const roles = (out: StoreNode[]) => out.map((x) => x.role)
const live = (params: Record<string, unknown>): AssembleCtx => ({ params, mode: 'live' })

/** Типовая запечённая дуэльная сессия: префиксы двух сторон + post + гритинг + история. */
function baked(): StoreNode[] {
  return [
    n('meta', ''),
    n('system', 'BOT PROMPT', { flags: { hidden: true, frozen: true }, meta: { side: 'bot' } }),
    n('system', 'PLAYER DOSSIER', { flags: { hidden: true, frozen: true }, meta: { side: 'player' } }),
    n('system', 'BOT POST', { flags: { hidden: true, frozen: true }, meta: { side: 'bot', position: 'post' } }),
    n('assistant', 'greeting'),
    n('user', 'player turn 1'),
    n('assistant', 'bot turn 1'),
  ]
}

// ── ГОЛДЕН: bit-паритет с sim/lib/assemble (spec §5.2, §6) ───────────────────

describe('assembleV0 — голден bit-паритет с sim', () => {
  it('bot-перспектива: свой префикс + post, чужой отфильтрован, relabel тождествен', () => {
    const out = assembleV0(baked(), live({ as: 'bot' }))
    expect(texts(out)).toEqual(['BOT PROMPT', 'greeting', 'player turn 1', 'bot turn 1', 'BOT POST'])
    expect(roles(out)).toEqual(['system', 'assistant', 'user', 'assistant', 'system'])
  })

  it('player-перспектива: досье игрока, роли инвертированы, post бота отрезан', () => {
    const out = assembleV0(baked(), live({ as: 'player' }))
    expect(texts(out)).toEqual(['PLAYER DOSSIER', 'greeting', 'player turn 1', 'bot turn 1'])
    // greeting/bot turn — сторона bot → user; player turn → assistant
    expect(roles(out)).toEqual(['system', 'user', 'assistant', 'user'])
  })

  it('hidden включается в промпт (hidden ≠ не-в-промпт)', () => {
    const nodes = [n('system', 'S', { flags: { hidden: true }, meta: { side: 'bot' } }), n('user', 'hi')]
    expect(assembleV0(nodes, live({ as: 'bot' }))).toHaveLength(2)
  })

  it('meta и injected исключаются', () => {
    const nodes = [
      n('meta', 'header'),
      n('injection', 'lore', { flags: { injected: true, hidden: true } }),
      n('user', 'hi'),
    ]
    const out = assembleV0(nodes, live({ as: 'bot' }))
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
  })

  it('trim: хвост истории limit, префиксы не считаются', () => {
    const nodes = [
      n('system', 'P', { meta: { side: 'bot' }, flags: { hidden: true } }),
      n('user', 'u1'),
      n('assistant', 'a1'),
      n('user', 'u2'),
      n('assistant', 'a2'),
    ]
    const out = assembleV0(nodes, live({ as: 'bot', limit: 2 }))
    expect(texts(out)).toEqual(['P', 'u2', 'a2'])
  })

  it('неизвестная роль без side проходит насквозь без relabel (graceful degradation)', () => {
    const nodes = [n('narrator', 'scene'), n('user', 'hi')]
    const out = assembleV0(nodes, live({ as: 'bot' }))
    expect(roles(out)).toEqual(['narrator', 'user'])
  })
})

// ── speaker (авторство, spec §5.1) ───────────────────────────────────────────

describe('speaker', () => {
  it('явный side побеждает ролевой дефолт', () => {
    expect(speaker(n('assistant', 'x'))).toBe('bot')
    expect(speaker(n('user', 'x'))).toBe('player')
    expect(speaker(n('user', 'x', { meta: { side: 'bot' } }))).toBe('bot')
    expect(speaker(n('system', 'x'))).toBeUndefined()
  })
  it('name сильнее ролевого дефолта, слабее side', () => {
    expect(speaker(n('assistant', 'x', { name: 'Мако' }))).toBe('Мако')
    expect(speaker(n('assistant', 'x', { name: 'Мако', meta: { side: 'bot' } }))).toBe('bot')
  })
})

// ── профиль v0: аудитория (spec §5.1) ────────────────────────────────────────

describe('selectV0 — аудитория', () => {
  it('audience: нода едет только при as ∈ audience', () => {
    const pub = n('assistant', 'pub', { meta: { side: 'player', audience: ['player', 'bot'] } })
    const priv = n('assistant', 'priv', { meta: { side: 'player' } }) // audience = [player]
    const nodes = [pub, priv]
    expect(texts(selectV0(nodes, live({ as: 'bot' })))).toEqual(['pub'])
    expect(texts(selectV0(nodes, live({ as: 'player' })))).toEqual(['pub', 'priv'])
  })
  it('нет side/audience → видно всем', () => {
    const nodes = [n('user', 'hi')]
    expect(selectV0(nodes, live({ as: 'bot' }))).toHaveLength(1)
    expect(selectV0(nodes, live({ as: 'player' }))).toHaveLength(1)
  })
})

// ── replay-заглушка (spec §5.3) ──────────────────────────────────────────────

describe('replay-заглушка', () => {
  it('replay не роняет и НЕ фильтрует injected (в отличие от live)', () => {
    const nodes = [n('injection', 'lore', { flags: { injected: true } }), n('user', 'hi')]
    expect(selectV0(nodes, { params: { as: 'bot' }, mode: 'live' })).toHaveLength(1)
    const replay = selectV0(nodes, { params: { as: 'bot' }, mode: 'replay' })
    expect(replay).toHaveLength(2)
    // meta/аудитория всё равно действуют в replay
    expect(assembleV0(nodes, { params: { as: 'bot' }, mode: 'replay' })).toHaveLength(2)
  })
})

// ── контракт: чистота и тотальность (spec §3) ────────────────────────────────

describe('контракт шага', () => {
  it('чистота: вход не мутируется', () => {
    const nodes = baked()
    const snapshot = structuredClone(nodes)
    assembleV0(nodes, live({ as: 'player', limit: 1 }))
    expect(nodes).toEqual(snapshot)
  })

  it('тотальность: пустой вход легален', () => {
    expect(assembleV0([], live({ as: 'bot' }))).toEqual([])
  })

  it('тотальность: незнакомые роли/атрибуты — насквозь', () => {
    const nodes = [
      n('wibble', 'x', { meta: { foo: 42 } }),
      n('narrator', 'scene'),
      n('tool', 'result'),
    ]
    const out = assembleV0(nodes, live({ as: 'bot' }))
    expect(roles(out)).toEqual(['wibble', 'narrator', 'tool'])
  })

  it('relabel не мутирует ноду при смене роли (копия)', () => {
    const src = n('assistant', 'x')
    const out = relabelV0([src], live({ as: 'player' }))
    expect(out[0]).not.toBe(src) // копия
    expect(out[0].role).toBe('user')
    expect(src.role).toBe('assistant') // оригинал цел
  })

  it('relabel сохраняет name при смене роли (группа не сливается)', () => {
    const src = n('assistant', 'x', { name: 'Мако', meta: { side: 'x' } })
    const out = relabelV0([src], live({ as: 'y' }))
    expect(out[0].role).toBe('user')
    expect(out[0].name).toBe('Мако')
  })
})

// ── generic-фабрики (spec §4) ────────────────────────────────────────────────

describe('generic-шаги', () => {
  const nodes = () => [n('a', '1'), n('b', '2'), n('a', '3'), n('c', '4')]
  const ctx = live({})

  it('filter', () => {
    const out = filter((x) => x.role === 'a')(nodes(), ctx)
    expect(texts(out)).toEqual(['1', '3'])
  })

  it('partition front — стабильный вынос в начало', () => {
    const out = partition((x) => x.role === 'a', 'front')(nodes(), ctx)
    expect(texts(out)).toEqual(['1', '3', '2', '4'])
  })

  it('partition tail — стабильный вынос в хвост', () => {
    const out = partition((x) => x.role === 'a', 'tail')(nodes(), ctx)
    expect(texts(out)).toEqual(['2', '4', '1', '3'])
  })

  it('sliceTail: undefined = без среза, 0 = пусто, N = хвост', () => {
    expect(texts(sliceTail(() => undefined)(nodes(), ctx))).toEqual(['1', '2', '3', '4'])
    expect(sliceTail(() => 0)(nodes(), ctx)).toEqual([])
    expect(texts(sliceTail(() => 2)(nodes(), ctx))).toEqual(['3', '4'])
    expect(texts(sliceTail(() => 99)(nodes(), ctx))).toEqual(['1', '2', '3', '4'])
  })

  it('relabel: undefined = не трогать', () => {
    const src = nodes()
    const out = relabel(() => undefined)(src, ctx)
    expect(out[0]).toBe(src[0]) // та же ссылка
  })

  it('compose применяет слева направо', () => {
    const step = compose(
      filter((x) => x.role !== 'c'),
      partition((x) => x.role === 'a', 'tail'),
    )
    expect(texts(step(nodes(), ctx))).toEqual(['2', '1', '3'])
  })
})

// ── отдельные шаги v0 (order) ────────────────────────────────────────────────

describe('orderV0', () => {
  it('system → front, post → tail, история между', () => {
    const nodes = [
      n('user', 'u1'),
      n('system', 'sys', { meta: { side: 'bot' } }),
      n('system', 'post', { meta: { side: 'bot', position: 'post' } }),
      n('assistant', 'a1'),
    ]
    expect(texts(orderV0(nodes, live({ as: 'bot' })))).toEqual(['sys', 'u1', 'a1', 'post'])
  })
})

// ── trimV0 без лимита ────────────────────────────────────────────────────────

describe('trimV0', () => {
  it('limit не задан → без среза', () => {
    const nodes = [n('user', 'u1'), n('assistant', 'a1'), n('user', 'u2')]
    expect(trimV0(nodes, live({ as: 'bot' }))).toHaveLength(3)
  })
})
