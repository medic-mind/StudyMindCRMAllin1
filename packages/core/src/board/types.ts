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
  /** Optionally assign the card to a CRM user at creation time. */
  assigneeId: z.string().nullish(),
  /** Optionally schedule the call (date+time, stored UTC) at creation. */
  scheduledCallAt: z.date().nullish(),
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
  z.object({ kind: z.literal('infoPack'), id: z.string() }),
])
export type CallSummaryAttachmentRef = z.infer<typeof CallSummaryAttachmentRef>

/** Approved Trengo WhatsApp (HSM) template pick — sent via the template
 *  session so it is valid outside the 24-hour window. No PDF attachments on
 *  this path: the approved templates already carry the info-pack links. */
export const CallSummaryWhatsAppTemplate = z.object({
  templateId: z.number().int().positive(),
  templateTitle: z.string().trim().min(1).max(200),
  params: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(20),
        value: z.string().trim().max(500),
      }),
    )
    .max(20)
    .default([]),
})
export type CallSummaryWhatsAppTemplate = z.infer<typeof CallSummaryWhatsAppTemplate>

export const CallSummarySendInput = z.object({
  summaryInteractionId: z.string(),
  channels: z.object({
    slack: z.boolean().optional(),
    trengo: z.boolean().optional(),
    whatsapp: z.boolean().optional(),
    sms: z.boolean().optional(),
    email: z.boolean().optional(),
  }),
  slackChannelId: z.string().trim().min(1).max(64).optional(),
  /** Per-channel body overrides — the wizard composes the email and the text
   *  separately. A channel without an override sends the summary body. */
  channelBodies: z
    .object({
      whatsapp: z.string().trim().min(1).max(8000).optional(),
      sms: z.string().trim().min(1).max(8000).optional(),
      email: z.string().trim().min(1).max(8000).optional(),
      trengo: z.string().trim().min(1).max(8000).optional(),
    })
    .optional(),
  /** Subject for a fresh email when the contact has no Gmail thread yet. */
  emailSubject: z.string().trim().min(1).max(200).optional(),
  /** Full-Gmail extras for the email channel (recipient override + Cc/Bcc +
   *  send-from address). */
  emailTo: z.array(z.string().trim().email()).max(20).optional(),
  emailCc: z.array(z.string().trim().email()).max(20).optional(),
  emailBcc: z.array(z.string().trim().email()).max(20).optional(),
  emailFromAddress: z.string().trim().email().max(254).optional(),
  /** Trengo sender line (channel id) for a NEW WhatsApp/SMS conversation. */
  trengoChannelId: z.number().int().positive().optional(),
  /** Send the WhatsApp channel as this approved Trengo template. */
  whatsappTemplate: CallSummaryWhatsAppTemplate.optional(),
  /** Up to 10 attachments for the email channel. Ignored when email
   * isn't enabled. */
  emailAttachments: z.array(CallSummaryAttachmentRef).max(10).optional(),
  /** Files uploaded straight from the agent's device (base64). ≤8 MB each, ≤10. */
  uploadedAttachments: z
    .array(
      z.object({
        filename: z.string().trim().min(1).max(255),
        contentType: z.string().min(1).max(150),
        dataBase64: z.string().min(1),
      }),
    )
    .max(10)
    .optional(),
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
