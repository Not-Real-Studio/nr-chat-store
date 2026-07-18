/**
 * @notreal/chat-store — нейтральная модель чат-сессий + контракт хранилища.
 *
 * core = типы модели + чистая tree-математика + контракт драйвера + реестр,
 * zero-dep. Драйверы — сабпатами (`./mds`, `./pi`, `./claude`): потребитель
 * одного не тащит чужие зависимости.
 *
 * Ключевая инверсия (spec §1): анатомия сообщения (Part/Message/SessionInfo)
 * живёт здесь, nr-ui-protocol её ре-экспортирует и остаётся wire-слоем.
 *
 * Канон: S:\skills\nr-system.dev\specs\chat-store-spec.md
 */

// §3 модель
export type {
  SessionInfo,
  Participant,
  Message,
  MessageFlags,
  MessageMeta,
  Usage,
  Part,
  AnyPart,
  UnknownPart,
  KnownPartType,
  TextPart,
  ThinkingPart,
  ToolUsePart,
  ToolResultPart,
  FilePart,
  ImagePart,
  ErrorPart,
  CustomPart,
  SessionModel,
  StoreNode,
  NodeInput,
} from './model.js'

// §4 tree-математика + проекции
export {
  resolveTree,
  activeLeaf,
  activePath,
  siblingsOf,
  swipeInfo,
  descendToLeaf,
  nodeToMessage,
  toHistory,
  toThread,
  contentHash,
} from './tree.js'
export type { Tree, SwipeInfo, ThreadNode } from './tree.js'

// §5 контракт драйвера
export {
  StoreConflictError,
  StoreNodeNotFound,
  StoreSessionNotFound,
  partsOf,
  replaceTextParts,
} from './store.js'
export type { SessionStore, StoreCapabilities, NodePatch } from './store.js'

// §6 реестр
export { register, unregister, registered, getStore } from './registry.js'
export type { StoreFactory } from './registry.js'
