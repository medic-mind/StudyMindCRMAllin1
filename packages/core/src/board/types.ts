// Board domain types (ADR 0018). Single source of truth for board, card,
// label, and subject inputs — shared by tRPC procedures and React Hook Form
// schemas. Pure Zod, no I/O. See CLAUDE.md §30.

import { z } from 'zod'

import { ContactCreateInput } from '../contact/types'

const Name = z.string().trim().min(1).max(80)
/** Tailwind token name (e.g. `blue-600`) or hex string. */
const Color = z.string().trim().min(1).max(32)
const Position = z.number().int().min(1).max(9999)

// --- Board -----------------------------------------------------------------

export const BoardCreateInput = z.object({
  name: Name,
  description: z.string().trim().max(500).optional(),
  isDefault: z.boolean().default(false),
})
export type BoardCreateInput = z.infer<typeof BoardCreateInput>

export const BoardUpdateInput = z.object({
  id: z.string(),
  name: Name.optional(),
  description: z.string().trim().max(500).nullish(),
  isDefault: z.boolean().optional(),
})
export type BoardUpdateInput = z.infer<typeof BoardUpdateInput>

export const BoardReorderInput = z.object({
  orderedIds: z.array(z.string()).min(1).max(50),
})
export type BoardReorderInput = z.infer<typeof BoardReorderInput>

export const BoardQuickActionsInput = z.object({
  boardId: z.string(),
  tickStageId: z.string().nullable(),
  xStageId: z.string().nullable(),
})
export type BoardQuickActionsInput = z.infer<typeof BoardQuickActionsInput>

// --- Card ------------------------------------------------------------------

/**
 * A card is backed by a Contact. The caller either links an existing contact
 * by id or supplies raw contact fields (validated by the shared
 * `ContactCreateInput`) which the create path turns into a new Contact.
 */
export const CardContactInput = z.union([
  z.object({ contactId: z.string() }),
  z.object({ contact: ContactCreateInput }),
])
export type CardContactInput = z.infer<typeof CardContactInput>

export const CardCreateInput = z.object({
  boardId: z.string(),
  stageId: z.string(),
  contact: CardContactInput,
  subjectId: z.string().optional(),
  labelIds: z.array(z.string()).max(20).optional(),
  /** Optional free-text note shown as the card's description preview. */
  description: z.string().trim().max(2000).optional(),
})
export type CardCreateInput = z.infer<typeof CardCreateInput>

export const CardMoveInput = z.object({
  cardId: z.string(),
  toStageId: z.string(),
  toPosition: Position.optional(),
})
export type CardMoveInput = z.infer<typeof CardMoveInput>

export const CardUpdateInput = z.object({
  id: z.string(),
  subjectId: z.string().nullish(),
  /** Assigned CRM user; pass null to clear. */
  assigneeId: z.string().nullish(),
  /** Due date; pass null to clear. */
  dueAt: z.date().nullish(),
  /** Scheduled call date+time (CLAUDE.md §6.4); pass null to clear. */
  scheduledCallAt: z.date().nullish(),
  /** Priority 1 (highest) – 4. Pass null to clear. */
  priority: z.number().int().min(1).max(4).nullish(),
})
export type CardUpdateInput = z.infer<typeof CardUpdateInput>

export const CardSetLabelsInput = z.object({
  cardId: z.string(),
  labelIds: z.array(z.string()).max(20),
})
export type CardSetLabelsInput = z.infer<typeof CardSetLabelsInput>

export const CardSetSubjectInput = z.object({
  cardId: z.string(),
  subjectId: z.string().nullable(),
})
export type CardSetSubjectInput = z.infer<typeof CardSetSubjectInput>

// --- Call summary (slice B) ------------------------------------------------

export const CallOutcomeEnum = z.enum(['answered', 'voicemail', 'no_answer'])
export type CallOutcomeEnum = z.infer<typeof CallOutcomeEnum>

export const CallSummaryAddInput = z.object({
  cardId: z.string(),
  body: z.string().trim().min(1).max(4000),
  outcome: CallOutcomeEnum.optional(),
})
export type CallSummaryAddInput = z.infer<typeof CallSummaryAddInput>

/** Tagged ids the email channel can attach. Resolved server-side to bytes. */
export const CallSummaryAttachmentRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('contactDocument'), id: z.string() }),
  z.object({ kind: z.literal('uploadedInvoice'), id: z.string() }),
  z.object({ kind: z.literal('callSummaryTemplatePdf'), id: z.string() }),
])
export type CallSummaryAttachmentRef = z.infer<typeof CallSummaryAttachmentRef>

export const CallSummarySendInput = z.object({
  summaryInteractionId: z.string(),
  channels: z.object({
    slack: z.boolean().optional(),
    trengo: z.boolean().optional(),
    email: z.boolean().optional(),
  }),
  slackChannelId: z.string().trim().min(1).max(64).optional(),
  /** Up to 10 attachments for the email channel. Ignored when email
   * isn't enabled. */
  emailAttachments: z.array(CallSummaryAttachmentRef).max(10).optional(),
})
export type CallSummarySendInput = z.infer<typeof CallSummarySendInput>

// --- Label -----------------------------------------------------------------

export const LabelCreateInput = z.object({
  name: Name,
  color: Color,
})
export type LabelCreateInput = z.infer<typeof LabelCreateInput>

export const LabelUpdateInput = z.object({
  id: z.string(),
  name: Name.optional(),
  color: Color.optional(),
})
export type LabelUpdateInput = z.infer<typeof LabelUpdateInput>

// --- Subject ---------------------------------------------------------------

export const SubjectCreateInput = z.object({
  name: Name,
})
export type SubjectCreateInput = z.infer<typeof SubjectCreateInput>

export const SubjectQueryInput = z.object({
  q: z.string().trim().max(80).optional(),
})
export type SubjectQueryInput = z.infer<typeof SubjectQueryInput>
