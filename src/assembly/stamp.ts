/**
 * Штамп контекста у реплик человека (DEV-426): модель знает, когда и откуда ей пишут.
 * `[14:30]` — у каждой реплики; дата — в первой и при смене дня; устройство — в первой
 * и при смене (`· air (Радом)`). Считается из меты узлов пути (`createdAt` + `client`),
 * поэтому одинаков на каждом ходе — кэш промпта не ломается.
 */
import type { MessageMeta } from '../model.js'

/** Откуда пишет человек: шлёт фронт в `RunStartInput.client`, бэкенд кладёт в мету реплики. */
export interface ClientContext {
  /** Имя устройства (`air`, `phone`) — для машин совпадает с хостом реестра устройств стенда. */
  device?: string
  /** Где человек, словами (`Радом`). */
  place?: string
  /** Часовой пояс IANA (`Europe/Warsaw`). */
  tz?: string
}

/** Чистит `client` из провода: только строки, обрезанные. */
export function clientContextOf(v: unknown): ClientContext | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const out: ClientContext = {}
  for (const k of ['device', 'place', 'tz'] as const) {
    const s = typeof o[k] === 'string' ? (o[k] as string).trim().slice(0, 80) : ''
    if (s) out[k] = s
  }
  return Object.keys(out).length ? out : undefined
}

function validTz(tz: string | undefined): string | undefined {
  if (!tz) return undefined
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return tz
  } catch {
    return undefined
  }
}

function parts(at: Date, tz: string | undefined): { date: string; time: string; day: string } {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
  const p: Record<string, string> = {}
  for (const x of f.formatToParts(at)) p[x.type] = x.value
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, day: p.weekday ?? '' }
}

/**
 * Штампы по узлам пути, параллельно `nodes`: строка у реплики человека с `createdAt`,
 * `undefined` у остальных. `tz` — пояс по умолчанию (у реплики свой — из `client.tz`).
 */
export function contextStamps(nodes: readonly { role: string; meta?: MessageMeta }[], opts: { tz?: string } = {}): (string | undefined)[] {
  let lastDate: string | undefined
  let lastWhere: string | undefined
  return nodes.map((n) => {
    if (n.role !== 'user' || typeof n.meta?.createdAt !== 'string') return undefined
    const at = new Date(n.meta.createdAt)
    if (Number.isNaN(at.getTime())) return undefined
    const client = clientContextOf(n.meta.client)
    const p = parts(at, validTz(client?.tz) ?? validTz(opts.tz))
    let s = p.time
    if (p.date !== lastDate) s = `${p.date} ${p.day} ${s}`
    lastDate = p.date
    if (client?.device) {
      const where = client.place ? `${client.device} (${client.place})` : client.device
      if (where !== lastWhere) s += ` · ${where}`
      lastWhere = where
    }
    return `[${s}]`
  })
}

/** Хвост штампа к частям реплики: к последнему тексту, нет текста — отдельной частью. */
export function withStamp<P extends { type: string }>(parts: readonly P[], stamp: string | undefined): P[] {
  if (!stamp) return [...parts]
  const out = [...parts]
  for (let i = out.length - 1; i >= 0; i--) {
    const p = out[i] as P & { text?: unknown }
    if (p.type === 'text' && typeof p.text === 'string') {
      out[i] = { ...p, text: `${p.text}\n\n${stamp}` }
      return out
    }
  }
  return [...out, { type: 'text', text: stamp } as unknown as P]
}

/** Строка system: что значит штамп и где смотреть устройства. */
export function stampSystemLine(devicesRef?: string): string {
  return `В конце реплик пользователя — штамп [время], дата — при смене дня, «· устройство (место)» — при смене устройства.${devicesRef ? ` Устройства пользователя и как до них дойти (ssh) — ${devicesRef}; путь из реплики относится к устройству, с которого она пришла.` : ''}`
}

/** Путь ленты со штампами в репликах человека (nr: до сборки; ACP: ход и пересборка транскрипта). */
export function stampMessages<M extends { role: string; parts: readonly { type: string }[]; meta?: MessageMeta }>(messages: readonly M[], opts: { tz?: string } = {}): M[] {
  const stamps = contextStamps(messages, opts)
  return messages.map((m, i) => (stamps[i] ? { ...m, parts: withStamp(m.parts, stamps[i]) } : m))
}
