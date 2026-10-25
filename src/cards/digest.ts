/**
 * Сводка за период (DEV-428 §4): разговоры (`talk`) за N дней по пространствам —
 * заголовок, «о чём», «Висит» и «Ждёт Дениса», ссылка на сессию; внизу — общий
 * список «ждёт Дениса». Чистая функция: сессии и карточки даёт вызывающий.
 */

import type { SessionInfo } from '../model.js'
import { CARD_FILE, LEGACY_CARD_FILE, type CardDoc, parseCard, sessionHref } from './card.js'

export interface DigestEntry {
  info: SessionInfo
  card?: CardDoc | null
}

export interface DigestOpts {
  days: number
  /** Только это пространство (`SessionInfo.workspace`; `default` — без пометки). */
  space?: string
  now?: Date
}

const spaceOf = (s: SessionInfo): string => s.workspace || 'default'
const lastOf = (e: DigestEntry): string => e.card?.head.last ?? e.info.updatedAt ?? e.info.createdAt ?? ''

/** Сессии, попадающие в сводку: разговоры с активностью за период (и пространство, если задано). */
export function digestPick(entries: readonly DigestEntry[], o: DigestOpts): DigestEntry[] {
  const since = new Date((o.now ?? new Date()).getTime() - o.days * 86400_000).toISOString()
  return entries
    .filter((e) => (e.info.kind ?? 'talk') === 'talk' && !e.info.noCloud)
    .filter((e) => (o.space ? spaceOf(e.info) === o.space : true))
    .filter((e) => lastOf(e) >= since && (e.info.messageCount ?? 1) > 0)
    .sort((a, b) => lastOf(b).localeCompare(lastOf(a)))
}

/** Документ сводки (markdown). */
export function buildDigest(entries: readonly DigestEntry[], o: DigestOpts): string {
  const now = o.now ?? new Date()
  const picked = digestPick(entries, o)
  const out: string[] = [`# Сводка чатов за ${o.days} ${o.days === 1 ? 'день' : o.days < 5 ? 'дня' : 'дней'}${o.space ? ` · ${o.space}` : ''}`, '', `${now.toISOString().slice(0, 16).replace('T', ' ')} UTC · разговоров ${picked.length} · без карточки ${picked.filter((e) => !e.card).length}`, '']
  const bySpace = new Map<string, DigestEntry[]>()
  for (const e of picked) (bySpace.get(spaceOf(e.info)) ?? bySpace.set(spaceOf(e.info), []).get(spaceOf(e.info))!).push(e)
  const waiting: string[] = []
  for (const [space, list] of [...bySpace].sort((a, b) => b[1].length - a[1].length)) {
    out.push(`## ${space}`, '')
    for (const e of list) {
      const title = e.card?.head.title || e.info.title || 'без названия'
      const when = lastOf(e).slice(0, 16).replace('T', ' ')
      out.push(`### [${title}](${sessionHref(e.info.id)})`, '')
      out.push(`${when}${e.card?.head.about ? ' · ' + e.card.head.about : e.card ? '' : ' · карточки ещё нет'}`, '')
      const open = e.card?.sections['Висит']?.filter((l) => l !== '—') ?? []
      const wait = e.card?.sections['Ждёт Дениса']?.filter((l) => l !== '—') ?? []
      if (open.length) out.push('Висит:', ...open.map((l) => `- ${l}`), '')
      if (wait.length) {
        out.push('Ждёт Дениса:', ...wait.map((l) => `- ${l}`), '')
        for (const l of wait) waiting.push(`- ${l} — [${title}](${sessionHref(e.info.id)})`)
      }
    }
  }
  out.push('## Ждёт Дениса — всё', '', ...(waiting.length ? waiting : ['—']), '')
  return out.join('\n')
}

/** Файл карточки сессии: `<id>.mds` → `<id>.assets/card.mdz`. */
export function cardPathOf(sessionFile: string): string {
  return sessionFile.replace(/\.mds$/, '') + '.assets/' + CARD_FILE
}

/** Прежний файл карточки (`card.md`, фронтматтер): читается, пока писатель не заменил его на `.mdz`. */
export function legacyCardPathOf(sessionFile: string): string {
  return sessionFile.replace(/\.mds$/, '') + '.assets/' + LEGACY_CARD_FILE
}

/**
 * Сессии каталогов и их карточки — вход сводки. Ввод-вывод даёт вызывающий:
 * `list` — список каталога (`createNrChatStore({dir}).list()`), `read` — текст файла или `null`.
 */
export async function collectDigestEntries(
  dirs: readonly string[],
  io: { list(dir: string): Promise<SessionInfo[]>; read(path: string): Promise<string | null> },
): Promise<DigestEntry[]> {
  const out: DigestEntry[] = []
  for (const dir of dirs) {
    let list: SessionInfo[] = []
    try {
      list = await io.list(dir)
    } catch {
      continue
    }
    for (const info of list) {
      const text = info.file ? ((await io.read(cardPathOf(info.file)).catch(() => null)) ?? (await io.read(legacyCardPathOf(info.file)).catch(() => null))) : null
      out.push({ info, card: text ? parseCard(text) : null })
    }
  }
  return out
}
