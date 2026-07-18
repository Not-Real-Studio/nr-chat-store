/**
 * @notrealstudio/nr-chat-store — neutral chat-session model + storage contract.
 *
 * core = model types + pure tree math + driver contract + registry, zero-dep.
 * Drivers ship as subpaths (`./mds`, `./pi`, `./claude`): a consumer of one
 * doesn't drag in the others' dependencies.
 *
 * Key inversion (spec §1): message anatomy (Part/Message/SessionInfo) lives
 * here; nr-ui-protocol re-exports it and stays the wire layer.
 *
 * Canon: S:\skills\nr-system.dev\specs\chat-store-spec.md
 */

// §3 model
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

// §4 tree math + projections
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

// §5 driver contract
export {
  StoreConflictError,
  StoreNodeNotFound,
  StoreSessionNotFound,
  StoreInvalidId,
  assertSafeId,
  assertSafeAssetName,
  partsOf,
  replaceTextParts,
} from './store.js'
export type { SessionStore, StoreCapabilities, NodePatch } from './store.js'

// §6 registry
export { register, unregister, registered, getStore } from './registry.js'
export type { StoreFactory } from './registry.js'
