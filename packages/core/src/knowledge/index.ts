// Company knowledge base ("Protocols & Policies") — the Crib import.
// ADR 0040. Pure domain module: static content + reshaping + search +
// AI-context selection. No I/O, no DB.

export { buildKnowledgeContext, DEFAULT_CONTEXT_CHAR_BUDGET } from './context'
export { knowledgeSectionPlainText, renderToPlainText } from './plain-text'
export { humaniseKey, toRenderTree } from './render-tree'
export { searchKnowledge, tokeniseQuery } from './search'
export {
  getKnowledgeData,
  getKnowledgeSection,
  getKnowledgeSectionData,
  KNOWLEDGE_GROUP_ORDER,
  KNOWLEDGE_SECTIONS,
  listKnowledgeSections,
} from './sections'
export type {
  KnowledgeCard,
  KnowledgeContext,
  KnowledgeContextSection,
  KnowledgeEntry,
  KnowledgeGroup,
  KnowledgeNode,
  KnowledgeSearchResult,
  KnowledgeSectionDef,
  KnowledgeValue,
} from './types'
