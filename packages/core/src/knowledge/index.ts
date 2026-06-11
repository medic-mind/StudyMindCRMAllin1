// Company knowledge base ("Protocols & Policies") — the Crib import.
// ADR 0040. Pure domain module: static baseline + DB-overridable live
// store + reshaping + search + AI-context selection + the patch engine
// behind the in-app AI editor.

export { buildKnowledgeContext, DEFAULT_CONTEXT_CHAR_BUDGET } from './context'
export {
  applyKnowledgePatches,
  getAtPath,
  knowledgePatchSchema,
  MAX_KNOWLEDGE_DOCUMENT_CHARS,
} from './patches'
export { knowledgeSectionPlainText, renderToPlainText } from './plain-text'
export { humaniseKey, toRenderTree } from './render-tree'
export { searchKnowledge, tokeniseQuery } from './search'
export { getKnowledgeData, KNOWLEDGE_GROUP_ORDER, KNOWLEDGE_SECTIONS } from './sections'
export {
  baselineKnowledgeStore,
  buildKnowledgeStore,
  getKnowledgeSection,
  getKnowledgeSectionData,
  KNOWLEDGE_OVERRIDE_ID,
  loadKnowledgeStore,
  type KnowledgeDb,
} from './store'
export type {
  KnowledgeCard,
  KnowledgeContext,
  KnowledgeContextSection,
  KnowledgeEntry,
  KnowledgeGroup,
  KnowledgeNode,
  KnowledgePatch,
  KnowledgePatchOp,
  KnowledgeSearchResult,
  KnowledgeSectionDef,
  KnowledgeStore,
  KnowledgeValue,
} from './types'
