/**
 * @notrealstudio/nr-chat-store/assembly — policy-трансформ линеек (spec §2).
 *
 * Сабпат, не пакет: модель (StoreNode/flags) — тот же пакет. Граница энфорсится
 * boundary-тестом (test/assembly-boundary.test.ts). Вынос в пакет — по внешнему
 * потребителю, переносом папки.
 *
 * Canon: nrchat.dev/specs/nr-chat-store-assembly-spec.md
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

// Лорбук (session-meta-spec §8–9; перенос из pi-ext-session-meta, DEV-222)
export {
  DEFAULT_SCAN_DEPTH,
  DEFAULT_TOKEN_BUDGET,
  LOREBOOK_INJECTION_SOURCE,
  LORE_SOURCE_KINDS,
  entryDepth,
  entryName,
  entryPosition,
  keyMatches,
  loreSourceLabel,
  lorebookOf,
  poolBudget,
  scanDepthOf,
  selectLore,
  selectLorebook,
  tokenBudgetOf,
} from './lorebook.js'
export type {
  DroppedEntry,
  FiredEntry,
  LoreDepthRole,
  LoreOptions,
  LorePosition,
  LoreSelection,
  LoreSource,
  LoreSourceKind,
  Lorebook,
  LorebookEntry,
} from './lorebook.js'
export { estimateTokens } from './tokens.js'

// RP-сборка: story string, глубина, impersonate, «продолжай» (DEV-222)
export {
  CONTINUE_FLAG,
  CONTINUE_TEXT,
  DEFAULT_IMPERSONATE_TEMPLATE,
  IMPERSONATE_MACROS,
  impersonatePrompt,
  injectAtDepth,
  joinStart,
  macrosOf,
  renderMacros,
  storyString,
  stripName,
} from './rp.js'
export type { ImpersonatePersona, MacroVars, StoryFrame, SystemBlock } from './rp.js'

// Персоны: правила имён, блок участников (personas-spec §1–4; из nr-ui-protocol, DEV-224)
export {
  PERSONAS_CUSTOM_TYPE,
  PERSONA_INJECTION_SOURCE,
  charPersonas,
  expandPersonaNames,
  isPersona,
  isPersonasDoc,
  personaPrefixed,
  personasDocOf,
  personasSystemBlock,
  personasVoiced,
  stripPersonaPrefix,
  turnPersona,
  userPersona,
  validatePersonas,
} from './personas.js'

// RP-сборка целиком — одна на backend-nr и pi-ext (DEV-224)
export {
  CONTINUE_SOURCE,
  DEPTH_PROMPT_SOURCE,
  IMPERSONATE_SOURCE,
  SYNTHETIC_ID_PREFIX,
  assembleRp,
  depthPromptOf,
  hasRpLayer,
  textOf,
} from './assemble-rp.js'
export type { ProfileLore, RpAssembled, RpInjection, RpInput, RpSessionMeta } from './assemble-rp.js'
