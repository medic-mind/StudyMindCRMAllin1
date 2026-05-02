// Interaction view-models. See CLAUDE.md Section 26.

import type { InteractionListItem, InteractionType } from '@studymind/core/interaction'

export type { InteractionListItem } from '@studymind/core/interaction'

interface InteractionRow {
  id: string
  type: InteractionType
  occurredAt: Date
  summary: string | null
  contactId: string | null
  familyId: string | null
  createdById: string | null
}

export function toInteractionListItem(row: InteractionRow): InteractionListItem {
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurredAt,
    summary: row.summary,
    authorId: row.createdById,
    contactId: row.contactId,
    familyId: row.familyId,
  }
}
