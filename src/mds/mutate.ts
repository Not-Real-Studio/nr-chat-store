/**
 * mds-кодек — мутации как патчи (слито из nr-session, §6).
 *
 * Тот же принцип, что `replaceSpan` в nr-chat: хирургия, байты вне патча
 * неприкосновенны. Функции возвращают `Patch[]`, применяет их потребитель
 * (`applyPatches` — чистый хелпер, IO не делает). Append — дозапись в конец
 * (append-only сохраняется), splice — точечная правка спана.
 */

import { replaceSpan, stringify } from '@notrealstudio/nr-chat'
import type { ChatMessage, Span } from '@notrealstudio/nr-chat'
import type { Part } from '../model.js'
import type { Session, SessionHeader, SessionNode } from './session.js'
import { META_ROLE } from './session.js'
import { activePath, descendToLeaf, resolveTree, swipeInfo, type Tree } from './tree.js'
import { partToSubMessage } from './parts.js'

/** Патч: дозапись в конец (`append`) либо замена спана (`splice`) (§6). */
export type Patch =
  | { kind: 'append'; text: string }
  | { kind: 'splice'; span: Span; replacement: string }

/** Описание сообщения для дозаписи: тело/части + мета. */
export interface MessageInput {
  role: string
  name?: string
  meta?: Record<string, unknown>
  /** Части сообщения. Первый text-part → тело ноды, остальные → `%%`-суб-ноды. */
  parts?: Part[]
  /** Ярлык для одиночного text-part (взаимоисключающе с `parts`). */
  body?: string
}

export interface MutateOpts {
  /** Генератор коротких id (по умолчанию — 4-символьный base36 с проверкой уникальности). */
  genId?: () => string
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomId(): string {
  let s = ''
  for (let i = 0; i < 4; i++) s += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)]
  return s
}

/** Все id, уже занятые в файле (ноды + хедер) — чтобы новые не коллизировали. */
function existingIds(session: Session): Set<string> {
  const ids = new Set<string>()
  if (session.header?.id) ids.add(session.header.id)
  for (const node of session.nodes) if (node.id) ids.add(node.id)
  return ids
}

/** Фабрика уникального в файле id поверх переданного/дефолтного генератора. */
function idFactory(session: Session, opts?: MutateOpts): () => string {
  const taken = existingIds(session)
  const gen = opts?.genId ?? randomId
  return () => {
    let id = gen()
    while (taken.has(id)) id = gen()
    taken.add(id)
    return id
  }
}

/**
 * Каноническая маркер-строка (`%role name {meta}`) без тела. Через nr-chat
 * `stringify` — то же экранирование имени/меты, что и в остальном формате.
 */
function markerLine(role: string, name: string | undefined, meta: Record<string, unknown> | undefined): string {
  const msg: ChatMessage = { role, body: '' }
  if (name !== undefined) msg.name = name
  if (meta !== undefined) msg.meta = meta
  return stringify([msg]).replace(/\n$/, '')
}

/**
 * Спан только маркер-строки внутри спана ноды (первая строка). Правка меты не
 * трогает байты тела — тело переживает round-trip как есть.
 */
function markerSpan(text: string, fullSpan: Span): Span {
  const nl = text.indexOf('\n', fullSpan.start)
  const end = nl === -1 || nl > fullSpan.end ? fullSpan.end : nl
  return { start: fullSpan.start, end }
}

/** Splice-патч, переписывающий маркер ноды с новой метой (тело нетронуто). */
function editNodeMeta(session: Session, node: SessionNode, meta: Record<string, unknown>): Patch {
  return {
    kind: 'splice',
    span: markerSpan(session.text, node.message.span),
    replacement: markerLine(node.role, node.name, meta),
  }
}

/** Splice-патч, переписывающий маркер `%meta`-хедера с новой метой. */
function editHeaderMeta(session: Session, header: SessionHeader, meta: Record<string, unknown>): Patch {
  return {
    kind: 'splice',
    span: markerSpan(session.text, header.message.span),
    replacement: markerLine(META_ROLE, header.name, meta),
  }
}

/**
 * Резолв ссылки на ноду: явный id либо позиционный handle `pos:N` (как их
 * отдаёт `toProtocol`, §5). Через `pos:N` адресуется нода без явного id —
 * именно там мутация «проставит id при отсутствии».
 */
function resolveRef(session: Session, tree: Tree, ref: string): SessionNode | undefined {
  if (ref.startsWith('pos:')) {
    const n = Number(ref.slice(4))
    return Number.isInteger(n) ? session.nodes[n] : undefined
  }
  return tree.byId.get(ref)
}

/** Собрать mds-ноду (обычная нода + `%%`-суб-ноды) в текст для дозаписи. */
function buildNodeText(input: MessageInput, extraMeta: Record<string, unknown>): string {
  const parts: Part[] = input.parts ?? (input.body !== undefined ? [{ type: 'text', text: input.body }] : [])

  let bodyText = ''
  let rest = parts
  if (parts.length > 0 && parts[0].type === 'text') {
    bodyText = parts[0].text
    rest = parts.slice(1)
  }

  const mergedMeta = { ...(input.meta ?? {}), ...extraMeta }
  const parent: ChatMessage = { role: input.role, body: bodyText }
  if (input.name !== undefined) parent.name = input.name
  if (Object.keys(mergedMeta).length > 0) parent.meta = mergedMeta

  const messages: ChatMessage[] = [parent, ...rest.map(partToSubMessage)]
  return stringify(messages)
}

/**
 * Дозапись сообщения в конец файла как продолжение активного пути (§6).
 * Линейный случай (нет `currNode`, лист = последняя нода) — ноль меты, ноль
 * оверхеда: chain default сам делает новую ноду продолжением. Если активный
 * лист не последняя нода файла (мы на свайпнутой ветке), новой ноде проставляется
 * явный `parent`; при заданном `currNode` он переставляется на новый лист.
 */
export function appendMessage(session: Session, msg: MessageInput, opts?: MutateOpts): Patch[] {
  const tree = resolveTree(session.nodes)
  const patches: Patch[] = []

  const lastNode = session.nodes[session.nodes.length - 1]
  const currNode = session.header?.meta.currNode
  const hasCurr = typeof currNode === 'string'
  const leaf = hasCurr ? resolveRef(session, tree, currNode) ?? lastNode : lastNode

  const extraMeta: Record<string, unknown> = {}

  // Явный parent нужен, только если дозапись не продолжает последнюю ноду файла.
  if (leaf && leaf !== lastNode && leaf.id) {
    extraMeta.parent = leaf.id
  }

  patches.push({ kind: 'append', text: buildNodeText(msg, extraMeta) })

  // Новый лист становится последней нодой файла. Если currNode был задан, он
  // всё ещё указывает на старый лист — снимаем его, чтобы активным стал новый
  // (правило «нет currNode → лист = последняя нода», §2). Дешевле генерации id.
  if (hasCurr && session.header) {
    const nextMeta = { ...session.header.meta }
    delete nextMeta.currNode
    patches.push(editHeaderMeta(session, session.header, nextMeta))
  }

  return patches
}

/**
 * Ветвление в точке `nodeId` (§3, §6): новая нода-ребёнок узла ветвления,
 * дозаписью в конец файла с явным `parent`. Узлу ветвления проставляется `id`
 * при отсутствии; `currNode` переставляется на новую ноду. Regenerate = ветвь
 * от того же parent: вызвать с id родителя сообщения.
 */
export function branchAt(session: Session, nodeId: string, msg: MessageInput, opts?: MutateOpts): Patch[] {
  const tree = resolveTree(session.nodes)
  const target = resolveRef(session, tree, nodeId)
  if (!target) throw new Error(`chat-store/mds: branchAt — узел '${nodeId}' не найден`)

  const nextId = idFactory(session, opts)
  const patches: Patch[] = []

  // Узел ветвления должен быть адресуемым по id (новая ветка сошлётся на него
  // явным parent). Обычно id уже есть; при адресации по pos:N — проставим
  // (это и есть «id появляется у цели»). Правка — маркер-строка цели, тело цело.
  let targetId = target.id
  if (!targetId) {
    targetId = nextId()
    patches.push(editNodeMeta(session, target, { ...(target.meta ?? {}), id: targetId }))
  }

  // Новая ветка — дозапись в конец с явным parent. id новой ноде НЕ проставляем
  // (ленивый id, §3): она — последняя нода файла, а значит активный лист по
  // умолчанию (§2), currNode трогать не нужно — append-only сохраняется.
  patches.push({ kind: 'append', text: buildNodeText(msg, { parent: targetId }) })

  return patches
}

/** Направление свайпа для `swipeTo`. */
export type SwipeDir = { dir: 'next' | 'prev' }

/** Глубочайшая точка ветвления на активном пути (последняя дивергенция). */
function deepestBranchPoint(session: Session, tree: Tree): SessionNode | undefined {
  const path = activePath(session, tree)
  for (let i = path.length - 1; i >= 0; i--) {
    if (swipeInfo(path[i], tree).count > 1) return path[i]
  }
  return undefined
}

/**
 * Переключение активной ветки (§6): патч спана `%meta` (currNode). Цель —
 * конкретный `nodeId` либо направление `{dir}` среди siblings глубочайшей точки
 * ветвления активного пути. Меняется только маркер `%meta` (и, при нужде, id
 * листа-цели); остальные байты идентичны.
 *
 * @throws если нет хедера (некуда писать currNode) или цель не резолвится.
 */
export function swipeTo(session: Session, target: string | SwipeDir, opts?: MutateOpts): Patch[] {
  if (!session.header) throw new Error('chat-store/mds: swipeTo требует %meta-хедер (некуда писать currNode)')

  const tree = resolveTree(session.nodes)

  let node: SessionNode | undefined
  if (typeof target === 'string') {
    node = resolveRef(session, tree, target)
    if (!node) throw new Error(`chat-store/mds: swipeTo — узел '${target}' не найден`)
  } else {
    const branch = deepestBranchPoint(session, tree)
    if (!branch) throw new Error('chat-store/mds: swipeTo — на активном пути нет точки ветвления')
    const info = swipeInfo(branch, tree)
    const delta = target.dir === 'next' ? 1 : -1
    const next = Math.min(info.count - 1, Math.max(0, info.active + delta))
    node = info.siblings[next]
  }

  // Активный лист выбранной ветки — спуск к листу от выбранного узла.
  const leaf = descendToLeaf(node, tree)

  const nextId = idFactory(session, opts)
  const patches: Patch[] = []

  let leafId = leaf.id
  if (!leafId) {
    leafId = nextId()
    patches.push(editNodeMeta(session, leaf, { ...(leaf.meta ?? {}), id: leafId }))
  }

  patches.push(editHeaderMeta(session, session.header, { ...session.header.meta, currNode: leafId }))
  return patches
}

/**
 * Применить патчи к тексту (чистая функция, без IO). Splice'ы — справа налево
 * (по убыванию офсета), чтобы правки не сдвигали спаны друг друга; append'ы —
 * в конец, с разделяющим переводом строки при нужде.
 */
export function applyPatches(text: string, patches: Patch[]): string {
  let out = text

  const splices = patches.filter((p): p is Extract<Patch, { kind: 'splice' }> => p.kind === 'splice')
  splices.sort((a, b) => b.span.start - a.span.start)
  for (const s of splices) out = replaceSpan(out, s.span, s.replacement)

  for (const p of patches) {
    if (p.kind !== 'append') continue
    out = out.length > 0 && !out.endsWith('\n') ? out + '\n' + p.text : out + p.text
  }

  return out
}
