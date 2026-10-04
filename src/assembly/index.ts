/**
 * @notrealstudio/nr-chat-store/assembly — policy-трансформ линеек (spec §2).
 *
 * Сабпат, не пакет: модель (StoreNode/flags) — тот же пакет. Граница энфорсится
 * boundary-тестом (test/assembly-boundary.test.ts). Вынос в пакет — по внешнему
 * потребителю, переносом папки.
 *
 * Canon: S:\skills\nr-system.dev\specs\nr-chat-store-assembly-spec.md
 */

// §3 контракт
export { compose } from './contract.js'
export type { AssembleCtx, Step } from './contract.js'

// §4 generic-фабрики
export { filter, partition, sliceTail, relabel } from './steps.js'

// §5 профиль v0
export { selectV0, orderV0, trimV0, relabelV0, assembleV0, speaker } from './v0.js'

// ContextEngine (backend-nr-spec §5) — форма; узел компакции (запись compaction pi)
export { COMPACTION_HINT, applyCompaction, compactedView, compactionData, compactionPart } from './engine.js'
export type {
  AssembleRequest,
  AssembleResult,
  CompactReason,
  CompactRequest,
  CompactResult,
  CompactedView,
  CompactionData,
  ContextBudget,
  ContextEngine,
  TurnResult,
} from './engine.js'
