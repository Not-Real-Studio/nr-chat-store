/**
 * mds-драйвер — проекция nr-session ⇄ нейтральная модель (spec §7.1).
 *
 * nr-session хранит дерево лениво (`{id, parent}` в мете, `parent` отсутствует =
 * chain default). Драйвер **разворачивает** конвенцию при load: каждый узел
 * получает ЯВНЫЙ parent (общий знаменатель модели, §3). Сворачивание обратно —
 * в шаге записи (минимальная мета там, где chain default сам делает работу).
 */

import type { Session, SessionNode, PartDecoders } from '@notreal/nr-session'
import { resolveTree, activePath, assembleParts, headerToSessionInfo } from '@notreal/nr-session'
import type { MessageFlags, SessionModel, StoreNode } from '../model.js'

/** Стабильный id узла: явный из меты либо позиционный `pos:N` (§3). */
export function nodeSid(node: SessionNode): string {
  return node.id ?? `pos:${node.index}`
}

function flagsOf(meta: Record<string, unknown> | undefined): MessageFlags | undefined {
  if (!meta) return undefined
  const flags: MessageFlags = {}
  if (meta.hidden === true) flags.hidden = true
  if (meta.frozen === true) flags.frozen = true
  if (meta.injected === true) flags.injected = true
  return Object.keys(flags).length ? flags : undefined
}

/** Мета узла для модели: драйверо-специфика без структурных id/parent/flags. */
function metaOf(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined
  const { id: _id, parent: _parent, hidden: _h, frozen: _f, injected: _i, ...rest } = meta
  return Object.keys(rest).length ? rest : undefined
}

/**
 * Session → SessionModel: всё дерево, parent развёрнут в явный (§3). `activeLeaf`
 * из `currNode` хедера, если резолвится. `info` — из `%meta`.
 */
export function toModel(session: Session, decoders?: PartDecoders): SessionModel {
  const tree = resolveTree(session.nodes)

  const nodes: StoreNode[] = session.nodes.map((node) => {
    const parent = tree.parentOf.get(node) ?? null
    const out: StoreNode = {
      id: nodeSid(node),
      parent: parent ? nodeSid(parent) : null,
      role: node.role,
      parts: assembleParts(node, decoders),
    }
    if (node.name !== undefined) out.name = node.name
    const flags = flagsOf(node.meta)
    if (flags) out.flags = flags
    const meta = metaOf(node.meta)
    if (meta) out.meta = meta
    return out
  })

  const info = headerToSessionInfo(session.header, activePath(session, tree).length)

  const model: SessionModel = { info, nodes }

  const currNode = session.header?.meta.currNode
  const modelMeta: Record<string, unknown> = {}
  if (typeof currNode === 'string' && tree.byId.has(currNode)) modelMeta.activeLeaf = currNode
  if (Object.keys(modelMeta).length) model.meta = modelMeta

  return model
}
