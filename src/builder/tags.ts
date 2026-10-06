/**
 * Теги ntpl билдера `mds-template` (session-document-spec §4.5) и разметка
 * выхода рендера.
 *
 * Тело узла шаблона рендерится обычным nunjucks (делимитеры ntpl), а то, что
 * текстом не выразить, едет в выходе маркерами `\u0000…\u0000`, которые билдер
 * режет после рендера:
 *
 *  - `B:<источник>` … `E` — блок system: строка шаблона, целиком состоящая из
 *    `<< выражение >>`, источник — голова выражения (`card.description`);
 *  - `S:<источник>` — смена источника внутри блока (фильтр `card` выбрал
 *    `meta.prompt.pre`, запись лорбука в `lore.before`);
 *  - `H:<json>` — место истории (`<{ history }>`) со вставками `inject`;
 *  - `I:<json>` — вставка; легальна только в теле `history`;
 *  - `P` — место инструкции impersonate (`<{ impersonate }>`).
 */

import type nunjucks from 'nunjucks'

export const MARK = '\u0000'

export const mark = {
  block: (source: string) => `${MARK}B:${clean(source)}${MARK}`,
  end: () => `${MARK}E${MARK}`,
  source: (source: string) => `${MARK}S:${clean(source)}${MARK}`,
  history: (injects: InjectSpec[]) => `${MARK}H:${JSON.stringify(injects)}${MARK}`,
  inject: (spec: InjectSpec) => `${MARK}I:${JSON.stringify(spec)}${MARK}`,
  impersonate: () => `${MARK}P${MARK}`,
}

const MARKER_RE = /\u0000([^\u0000]*)\u0000/g

function clean(source: string): string {
  return source.replace(/\u0000/g, '')
}

/** Вставка на глубине: текст уже отрендерен, роль и глубина — посчитаны. */
export interface InjectSpec {
  at: number
  role: 'system' | 'user' | 'assistant'
  source: string
  text: string
  reason?: string
}

/** Куски отрендеренного тела узла: текст блоками, история, impersonate. */
export type RenderedPiece =
  | { kind: 'text'; blocks: Array<{ source: string; text: string }> }
  | { kind: 'history'; injects: InjectSpec[] }
  | { kind: 'impersonate' }

/** Срезать маркеры источника в начале текста (для фильтров, ставящих подпись). */
export function splitLeadingSources(text: string): { head: string; rest: string } {
  const m = /^(?:\u0000S:[^\u0000]*\u0000)*/.exec(text)
  const head = m ? m[0] : ''
  return { head, rest: text.slice(head.length) }
}

/** Текст без маркеров (для пустоты и сравнения). */
export function stripMarks(text: string): string {
  return text.replace(MARKER_RE, '')
}

/**
 * Разобрать выход рендера одного узла. `nodeSource` — источник свободного
 * текста узла (вне `<< >>`-строк). Ошибки: история внутри выражения/блока,
 * `inject` вне истории.
 */
export function parseRendered(text: string, nodeSource: string, where: string): RenderedPiece[] {
  const pieces: RenderedPiece[] = []
  let blocks: Array<{ source: string; text: string }> = []
  let cur = { source: nodeSource, text: '' }
  let inBlock = false
  const flush = () => {
    const t = cur.text.trim()
    if (t !== '') blocks.push({ source: cur.source, text: t })
  }
  const flushPiece = () => {
    flush()
    if (blocks.length) pieces.push({ kind: 'text', blocks })
    blocks = []
  }
  let last = 0
  for (const m of text.matchAll(MARKER_RE)) {
    cur.text += text.slice(last, m.index)
    last = m.index! + m[0].length
    const body = m[1]!
    const kind = body[0]
    const arg = body.slice(2)
    if (kind === 'B') {
      flush()
      cur = { source: arg, text: '' }
      inBlock = true
    } else if (kind === 'E') {
      flush()
      cur = { source: nodeSource, text: '' }
      inBlock = false
    } else if (kind === 'S') {
      flush()
      cur = { source: arg, text: '' }
    } else if (kind === 'H' || kind === 'P') {
      if (inBlock) throw new Error(`${where}: <{ ${kind === 'H' ? 'history' : 'impersonate'} }> — только на верхнем уровне узла, не внутри выражения`)
      flushPiece()
      pieces.push(kind === 'H' ? { kind: 'history', injects: JSON.parse(arg) as InjectSpec[] } : { kind: 'impersonate' })
      cur = { source: nodeSource, text: '' }
    } else if (kind === 'I') {
      throw new Error(`${where}: <{ inject }> — только внутри <{ history }>…<{ endhistory }>`)
    }
  }
  cur.text += text.slice(last)
  flushPiece()
  return pieces
}

// ────────────────────────────────────────────────────────────────────────────
// Препроцессинг тела шаблона
// ────────────────────────────────────────────────────────────────────────────

const ROLES = new Set(['system', 'user', 'assistant'])

/**
 * Тело узла шаблона → текст для nunjucks:
 *  - строка из одного `<< выражение >>` — блок с источником (головой выражения);
 *  - `<{ inject at=N role=system }>` — аргументы через запятую (как просит
 *    nunjucks), голые `system|user|assistant` — строками.
 */
export function preprocess(body: string): string {
  const injectFixed = body.replace(/<\{-?\s*inject\b([^}]*?)-?\}>/g, (whole, args: string) => {
    let a = args.replace(/\s+(?=[A-Za-z_]\w*\s*=(?!=))/g, ', ').replace(/^\s*,\s*/, ' ').replace(/,\s*,/g, ',')
    a = a.replace(/\b(role\s*=\s*)(system|user|assistant)\b(?!\s*[.(|'"])/g, (_, k: string, v: string) => (ROLES.has(v) ? `${k}'${v}'` : `${k}${v}`))
    return whole.replace(args, a.startsWith(' ') ? a : ` ${a}`)
  })
  return injectFixed.replace(/^([ \t]*)<<\s*(.+?)\s*>>[ \t]*$/gm, (whole, indent: string, expr: string) => {
    if (expr.includes('<<') || expr.includes('>>')) return whole
    return `${indent}${mark.block(sourceOfExpr(expr))}<< ${expr} >>${mark.end()}`
  })
}

/** Источник блока по выражению: путь до первого фильтра (`agent.pre | card` → `agent.pre`). */
export function sourceOfExpr(expr: string): string {
  const head = expr.split('|')[0]!.trim()
  return /^[A-Za-z_][\w.]*$/.test(head) ? head : 'template'
}

// ────────────────────────────────────────────────────────────────────────────
// Расширения nunjucks
// ────────────────────────────────────────────────────────────────────────────

type Kw = Record<string, unknown>

function kwOf(args: unknown[]): Kw {
  const last = args[args.length - 1]
  return last && typeof last === 'object' && (last as Kw).__keywords ? (last as Kw) : {}
}

/** `<{ history }>…<{ endhistory }>`: тело — только `inject`. */
class HistoryExtension implements nunjucks.Extension {
  tags = ['history']
  parse(parser: any, nodes: any): any {
    const tok = parser.nextToken()
    const args = parser.parseSignature(null, true)
    parser.advanceAfterBlockEnd(tok.value)
    const body = parser.parseUntilBlocks('endhistory')
    parser.advanceAfterBlockEnd()
    return new nodes.CallExtension(this, 'run', args, [body])
  }
  run(_ctx: unknown, ...rest: unknown[]): string {
    const body = rest[rest.length - 1] as () => string
    const out = body()
    if (out.includes(`${MARK}H:`)) throw new Error('<{ history }> внутри <{ history }>')
    const injects: InjectSpec[] = []
    let last = 0
    for (const m of out.matchAll(MARKER_RE)) {
      const between = out.slice(last, m.index)
      if (stripMarks(between).trim() !== '') throw new Error(`в теле <{ history }> — только <{ inject }>, а не текст: «${between.trim().slice(0, 40)}»`)
      last = m.index! + m[0].length
      if (m[1]!.startsWith('I:')) injects.push(JSON.parse(m[1]!.slice(2)) as InjectSpec)
      else throw new Error('в теле <{ history }> — только <{ inject }>')
    }
    if (out.slice(last).trim() !== '') throw new Error(`в теле <{ history }> — только <{ inject }>, а не текст: «${out.slice(last).trim().slice(0, 40)}»`)
    return mark.history(injects)
  }
}

/** `<{ inject at=N role=… source=… }>текст<{ endinject }>`. */
class InjectExtension implements nunjucks.Extension {
  tags = ['inject']
  parse(parser: any, nodes: any): any {
    const tok = parser.nextToken()
    const args = parser.parseSignature(null, true)
    parser.advanceAfterBlockEnd(tok.value)
    const body = parser.parseUntilBlocks('endinject')
    parser.advanceAfterBlockEnd()
    return new nodes.CallExtension(this, 'run', args, [body])
  }
  run(_ctx: unknown, ...rest: unknown[]): string {
    const body = rest[rest.length - 1] as () => string
    const kw = kwOf(rest.slice(0, -1))
    const text = stripMarks(body()).trim()
    if (text === '') return ''
    const atRaw = Number(kw.at)
    const at = Number.isFinite(atRaw) && atRaw >= 0 ? Math.floor(atRaw) : 4
    const role = kw.role === 'user' || kw.role === 'assistant' ? kw.role : 'system'
    const spec: InjectSpec = { at, role, source: typeof kw.source === 'string' && kw.source !== '' ? kw.source : 'inject', text }
    if (typeof kw.reason === 'string' && kw.reason !== '') spec.reason = kw.reason
    return mark.inject(spec)
  }
}

/** `<{ impersonate }>` — место инструкции «ответь за игрока». */
class ImpersonateExtension implements nunjucks.Extension {
  tags = ['impersonate']
  parse(parser: any, nodes: any): any {
    const tok = parser.nextToken()
    const args = parser.parseSignature(null, true)
    parser.advanceAfterBlockEnd(tok.value)
    return new nodes.CallExtension(this, 'run', args)
  }
  run(): string {
    return mark.impersonate()
  }
}

export function registerTags(env: nunjucks.Environment): void {
  env.addExtension('NrHistory', new HistoryExtension())
  env.addExtension('NrInject', new InjectExtension())
  env.addExtension('NrImpersonate', new ImpersonateExtension())
}
