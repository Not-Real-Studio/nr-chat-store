/**
 * `@notrealstudio/nr-chat-store/cards` — карточки чатов и сводка (DEV-428).
 * Без сети и без Node: модель зовёт вызывающий (`complete`), файлы пишет он же.
 */

export { buildCard, cardMessages, dedupFacts, fixFact, parseModelJson } from './pipeline.js'
export type { BuildCardOpts, CardComplete, CardFact, CardItem, CardMessage, CardRecord, CardUsage } from './pipeline.js'
export { CARD_FILE, CARD_SECTIONS, cardEntries, cardEntryKey, messageHref, parseCard, renderCard, sessionHref } from './card.js'
export type { CardDoc, CardEntry, CardHead } from './card.js'
export { buildDigest, cardPathOf, collectDigestEntries, digestPick } from './digest.js'
export type { DigestEntry, DigestOpts } from './digest.js'
export { PROMPT_EXT, PROMPT_RECORD, PROMPT_SEG } from './prompts.js'
