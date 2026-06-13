// Interaction (timeline) router. See CLAUDE.md Sections 6.2, 27.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  buildReplyDraftPrompt,
  REPLY_DRAFT_PROMPT_VERSION,
  replyDraftShape,
  runDraft,
  type ReplyChannel,
} from '@studymind/ai'
import { BusinessError } from '@studymind/core/errors'
import {
  InteractionCreateInput,
  type InteractionListItem,
} from '@studymind/core/interaction'

import { toInteractionListItem } from '@/lib/view-models/interaction'

import {
  auditedProcedure,
  enforceRestrictedAccess,
  protectedProcedure,
  requireUser,
  router,
} from '@/lib/trpc/builders'

const InteractionListInput = z
  .object({
    contactId: z.string().optional(),
    familyId: z.string().optional(),
    /** Required when listing for a restricted contact. CLAUDE.md §42.3. */
    purpose: z.string().min(1).optional(),
    cursor: z
      .object({
        id: z.string(),
        occurredAt: z.date(),
      })
      .nullish(),
    limit: z.number().min(1).max(100).default(25),
  })
  .refine((v) => !!v.contactId || !!v.familyId, {
    message: 'contactId or familyId is required',
  })

function newId(): string {
  return createId()
}

// Outbound attachment input (base64). Files travel through tRPC as base64;
// we cap each at ~8 MB and decode to Buffers before the integration uploads
// them to Trengo. Small-file path only — larger media should use a presigned
// upload (future).
const TrengoAttachmentInput = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().trim().min(1).max(120),
  dataBase64: z.string().min(1).max(12_000_000),
})

interface DecodedAttachment {
  filename: string
  contentType: string
  data: Buffer
}

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

function decodeTrengoAttachments(
  input: Array<z.infer<typeof TrengoAttachmentInput>> | undefined,
): DecodedAttachment[] {
  if (!input || input.length === 0) return []
  const out: DecodedAttachment[] = []
  for (const a of input) {
    const data = Buffer.from(a.dataBase64, 'base64')
    if (data.byteLength === 0) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: `Empty file: ${a.filename}` })
    }
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `${a.filename} exceeds the 8 MB limit.`,
      })
    }
    out.push({ filename: a.filename, contentType: a.contentType, data })
  }
  return out
}

export const interactionRouter = router({
  list: protectedProcedure
    .input(InteractionListInput)
    .query(async ({ ctx, input }) => {
      // Restricted-access enforcement. When listing for a specific contact,
      // we run the gate up-front. When listing by family, we filter out any
      // interaction tied to a restricted contact unless the caller is admin
      // or an assigned DSL on every restricted contact in that family.
      if (input.contactId) {
        await enforceRestrictedAccess(
          ctx,
          input.contactId,
          input.purpose ?? '',
        )
      }
      const restrictedContactIds = await getRestrictedContactIdsToHide(
        ctx,
        input.familyId,
      )
      const rows = await ctx.db.interaction.findMany({
        where: {
          deletedAt: null,
          ...(input.contactId ? { contactId: input.contactId } : {}),
          ...(input.familyId ? { familyId: input.familyId } : {}),
          ...(restrictedContactIds.length > 0
            ? { contactId: { notIn: restrictedContactIds } }
            : {}),
          ...(input.cursor
            ? {
                OR: [
                  { occurredAt: { lt: input.cursor.occurredAt } },
                  {
                    AND: [
                      { occurredAt: input.cursor.occurredAt },
                      { id: { lt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          type: true,
          occurredAt: true,
          summary: true,
          contactId: true,
          familyId: true,
          createdById: true,
          // Distilled into a small typed `meta` by toInteractionListItem —
          // the raw JSONB never reaches the client (CLAUDE.md §26).
          payload: true,
        },
      })

      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const items: InteractionListItem[] = sliced.map((r) =>
        toInteractionListItem({
          ...r,
          // Prisma returns the enum verbatim; cast to our narrower union.
          type: mapDbType(r.type),
        }),
      )
      const last = sliced[sliced.length - 1]
      const nextCursor =
        hasMore && last ? { id: last.id, occurredAt: last.occurredAt } : null
      return { items, nextCursor }
    }),

  create: auditedProcedure
    .input(InteractionCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // Phase 1: only manual notes from the UI. Other types come via integrations.
      if (input.type !== 'note') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only manual notes can be created via this endpoint today',
        })
      }
      // Validate referenced row(s) exist and aren't soft-deleted.
      if (input.contactId) {
        const c = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true },
        })
        if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
      }
      if (input.familyId) {
        const f = await ctx.db.family.findFirst({
          where: { id: input.familyId, deletedAt: null },
          select: { id: true },
        })
        if (!f) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found' })
      }

      const id = newId()
      const created = await ctx.db.interaction.create({
        data: {
          id,
          type: 'note',
          contactId: input.contactId ?? null,
          familyId: input.familyId ?? null,
          occurredAt: input.occurredAt ?? new Date(),
          summary: input.summary,
          payload: { body: input.body },
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'interaction.created',
        target: { type: 'Interaction', id: created.id },
        before: null,
        after: { id: created.id, type: created.type, summary: created.summary },
      })

      // Two-way sync: a note on a Summer Camp-linked contact is pushed back to
      // the camp booking. Best-effort — never fails the note creation; a no-op
      // for non-camp contacts (CLAUDE.md §15 summer-camp write-back).
      if (input.contactId && input.body) {
        const { pushNoteForContact } = await import('@studymind/integration-summer-camp/writeback')
        await pushNoteForContact(ctx.db, input.contactId, input.body, user.email).catch(() => null)
      }

      return { id: created.id }
    }),

  // CLAUDE.md §18 — AI-drafted reply. Returns text + promptVersion for
  // traceability. The agent edits and confirms via the existing outbound
  // path (Trengo, Gmail) which marks the Interaction as sent.
  draftReply: auditedProcedure
    .input(
      z.object({
        interactionId: z.string(),
        goal: z.string().min(1).max(500),
        channel: z.enum(['email', 'whatsapp', 'sms', 'web_chat']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const seed = await ctx.db.interaction.findFirst({
        where: { id: input.interactionId, deletedAt: null },
        select: { id: true, contactId: true, familyId: true, occurredAt: true },
      })
      if (!seed) throw new TRPCError({ code: 'NOT_FOUND' })
      if (seed.contactId) {
        await enforceRestrictedAccess(ctx, seed.contactId, 'reply-draft')
      }

      // Pull a small thread window. Prefer contact scope; fall back to family.
      const threadRows = await ctx.db.interaction.findMany({
        where: {
          deletedAt: null,
          ...(seed.contactId
            ? { contactId: seed.contactId }
            : { familyId: seed.familyId ?? undefined }),
        },
        orderBy: { occurredAt: 'desc' },
        take: 20,
        select: {
          type: true,
          occurredAt: true,
          summary: true,
          payload: true,
          createdById: true,
        },
      })
      const thread = threadRows.reverse().map((r) => {
        const payload = (r.payload ?? {}) as { body?: string; text?: string }
        const text = payload.body ?? payload.text ?? r.summary ?? ''
        const direction: 'inbound' | 'outbound' | 'internal' = r.createdById
          ? 'outbound'
          : 'inbound'
        return {
          type: r.type,
          occurredAt: r.occurredAt.toISOString(),
          direction,
          text,
        }
      })

      const channel = input.channel as ReplyChannel
      const prompt = buildReplyDraftPrompt({
        channel,
        goal: input.goal,
        thread,
      })
      const result = await runDraft({
        task: 'reply_draft',
        promptVersion: prompt.promptVersion,
        system: prompt.system,
        user: prompt.user,
        model: 'gpt-4o',
        contentShape: replyDraftShape(channel),
        contactId: seed.contactId ?? undefined,
        ctx: { interactionId: input.interactionId, agentId: user.id },
      })

      await ctx.audit({
        action: 'ai.draft_generated',
        target: { type: 'Interaction', id: input.interactionId },
        purpose: 'reply-draft',
        after: {
          channel,
          promptVersion: REPLY_DRAFT_PROMPT_VERSION,
          length: result.text.length,
        },
      })

      return {
        text: result.text,
        promptVersion: REPLY_DRAFT_PROMPT_VERSION,
        channel,
      }
    }),

  // Manual call log — used by the click-to-call buttons (Aircall + Google
  // Voice). We don't have a webhook for Google Voice and Aircall click-to-
  // call doesn't fire a webhook synchronously, so the agent records the
  // intent here. The Aircall webhook may later attach a fuller payload to
  // the same call thread; this stub interaction is the visible timeline
  // entry the agent sees immediately. CLAUDE.md §10.
  logManualCall: auditedProcedure
    .input(
      z.object({
        contactId: z.string(),
        provider: z.enum(['aircall', 'google_voice', 'manual']),
        direction: z.enum(['inbound', 'outbound']).default('outbound'),
        durationSec: z.number().int().min(0).max(60 * 60 * 8).optional(),
        outcome: z
          .enum(['answered', 'voicemail', 'no_answer', 'unknown'])
          .optional(),
        note: z.string().trim().max(2000).optional(),
        /** Phone number actually dialled, for the timeline summary. */
        toNumber: z.string().trim().max(40).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const contact = await ctx.db.contact.findFirst({
        where: { id: input.contactId, deletedAt: null },
        select: { id: true },
      })
      if (!contact) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
      }
      const id = newId()
      const now = new Date()
      const providerLabel =
        input.provider === 'aircall'
          ? 'Aircall'
          : input.provider === 'google_voice'
            ? 'Google Voice'
            : 'manual'
      const summary = `${input.direction === 'inbound' ? 'Inbound' : 'Outbound'} call via ${providerLabel}${
        input.toNumber ? ` to ${input.toNumber}` : ''
      }${
        input.outcome && input.outcome !== 'unknown'
          ? ` — ${input.outcome.replace('_', ' ')}`
          : ''
      }`
      const created = await ctx.db.interaction.create({
        data: {
          id,
          type: 'call',
          contactId: input.contactId,
          occurredAt: now,
          summary,
          payload: {
            event: 'call.manually_logged',
            provider: input.provider,
            manual: true,
            direction: input.direction,
            durationSec: input.durationSec ?? 0,
            outcome: input.outcome ?? null,
            toNumber: input.toNumber ?? null,
            note: input.note ?? null,
            loggedBy: user.id,
          },
          createdById: user.id,
          updatedById: user.id,
        },
        select: { id: true, occurredAt: true },
      })
      await ctx.audit({
        action: 'call.manually_logged',
        target: { type: 'Interaction', id: created.id },
        after: {
          contactId: input.contactId,
          provider: input.provider,
          direction: input.direction,
        },
      })
      return { id: created.id, occurredAt: created.occurredAt }
    }),

  // CLAUDE.md §14 — Gmail outbound reply. Resolves a seed `email_received`
  // Interaction, computes the reply recipients, and goes through the Gmail
  // outbound which is idempotent on (threadId, requestId).
  email: router({
    reply: auditedProcedure
      .input(
        z.object({
          interactionId: z.string(),
          body: z.string().trim().min(1).max(50_000),
          /** When true, prepend the original message body as a quoted block. */
          includeOriginal: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        // Sending outbound email is restricted to roles that can act on a
        // family's behalf. Virtual Assistants draft replies but cannot send.
        // ADR 0014.
        if (
          !['ceo', 'senior_manager', 'manager', 'sales_executive'].includes(user.role)
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'role cannot send email' })
        }

        const seed = await ctx.db.interaction.findFirst({
          where: { id: input.interactionId, deletedAt: null, type: 'email_received' },
          select: {
            id: true,
            contactId: true,
            familyId: true,
            occurredAt: true,
            summary: true,
            payload: true,
          },
        })
        if (!seed) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Inbound email Interaction not found.',
          })
        }
        if (seed.contactId) {
          await enforceRestrictedAccess(ctx, seed.contactId, 'email-reply')
        }

        const payload = (seed.payload ?? {}) as Record<string, unknown>
        const threadId = typeof payload['threadId'] === 'string' ? payload['threadId'] : null
        const subject =
          typeof payload['subject'] === 'string' ? payload['subject'] : seed.summary ?? ''
        const fromAddress =
          typeof payload['from'] === 'string'
            ? payload['from']
            : typeof payload['fromAddress'] === 'string'
              ? (payload['fromAddress'] as string)
              : null
        const toRaw = Array.isArray(payload['to']) ? (payload['to'] as unknown[]) : []
        const ccRaw = Array.isArray(payload['cc']) ? (payload['cc'] as unknown[]) : []
        const originalMessageId =
          typeof payload['messageId'] === 'string' ? payload['messageId'] : undefined
        const originalBody =
          typeof payload['body'] === 'string' ? payload['body'] : ''

        if (!threadId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No Gmail threadId on the inbound Interaction; cannot reply.',
          })
        }

        // Recipients: the from of the inbound becomes the To; original to/cc
        // become the cc minus our own connected mailbox address.
        const myMailbox = await ctx.db.gmailMailbox.findFirst({
          where: { agentId: user.id, deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { address: true },
        })
        const myAddress = myMailbox?.address?.toLowerCase() ?? null
        const filterMine = (s: string) =>
          myAddress ? s.trim().toLowerCase() !== myAddress : true

        const replyTo = fromAddress ? [fromAddress] : []
        const replyCc = [
          ...toRaw.filter((x): x is string => typeof x === 'string'),
          ...ccRaw.filter((x): x is string => typeof x === 'string'),
        ].filter(filterMine)

        if (replyTo.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No reply recipient could be derived from the inbound email.',
          })
        }

        const composed = input.includeOriginal && originalBody
          ? `${input.body}\n\n--- On ${seed.occurredAt.toISOString()} wrote: ---\n${originalBody}`
          : input.body

        // Lazy import keeps the Gmail SDK out of the unrelated tRPC bundle.
        const { sendReply } = await import('@studymind/integration-gmail/outbound')
        const result = await sendReply({
          agentId: user.id,
          threadId,
          subject,
          body: composed,
          toAddresses: replyTo,
          cc: replyCc.length > 0 ? replyCc : undefined,
          requestId: ctx.requestId,
          originalMessageId,
        })

        await ctx.audit({
          action: 'gmail.reply_requested',
          target: { type: 'OutboundEmailIntent', id: result.outboundEmailIntentId },
          after: {
            threadId,
            gmailMessageId: result.gmailMessageId,
            replayed: result.replayed,
          },
        })

        return result
      }),
  }),

  // CLAUDE.md §11 — Trengo outbound reply (WhatsApp / SMS / web-chat / email
  // via Trengo). Reuses the existing audited `sendMessage` outbound, which is
  // two-phase (pending_send → sent) and idempotent on requestId. The agent
  // never has to know the Trengo ticket id — we resolve the contact's active
  // conversation. Virtual Assistants draft but cannot send (ADR 0014 / §20.1).
  trengo: router({
    reply: auditedProcedure
      .input(
        z.object({
          interactionId: z.string(),
          // Body may be empty when sending an attachment-only message.
          body: z.string().trim().max(4_000).default(''),
          attachments: z.array(TrengoAttachmentInput).max(10).optional(),
          /** The exact ticket to reply on (the comms centre knows it from the
           *  Conversation head). Without it we fall back to resolving the
           *  contact's most recent conversation — which can miss imported
           *  threads whose message payloads carry no recognised channel. */
          ticketId: z.number().int().positive().optional(),
          channel: z.enum(['whatsapp', 'sms', 'email', 'web_chat']).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (
          !['ceo', 'senior_manager', 'manager', 'sales_executive'].includes(user.role)
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'role cannot send messages' })
        }
        const attachments = decodeTrengoAttachments(input.attachments)
        if (!input.body.trim() && attachments.length === 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Write a message or attach a file.',
          })
        }

        const seed = await ctx.db.interaction.findFirst({
          where: { id: input.interactionId, deletedAt: null },
          select: { id: true, contactId: true, payload: true },
        })
        if (!seed?.contactId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'No contact is linked to this message; cannot reply.',
          })
        }
        await enforceRestrictedAccess(ctx, seed.contactId, 'trengo-reply')

        // Resolve the target ticket + channel: explicit input (comms centre)
        // → the seed message's own payload → the contact's most recent
        // conversation. The explicit path makes replies deterministic — the
        // send lands on the ticket the agent is looking at.
        const seedPayload = (seed.payload ?? {}) as Record<string, unknown>
        const { isTrengoChannel } = await import('@studymind/integration-trengo/types')
        const seedTicketId =
          typeof seedPayload['ticketId'] === 'number'
            ? (seedPayload['ticketId'] as number)
            : null
        const seedChannelRaw =
          typeof seedPayload['channel'] === 'string'
            ? (seedPayload['channel'] as string)
            : null
        let ticketId = input.ticketId ?? seedTicketId
        let channel =
          input.channel ??
          (seedChannelRaw && isTrengoChannel(seedChannelRaw) ? seedChannelRaw : null)

        if (ticketId === null || channel === null) {
          // Lazy imports keep the integration out of the unrelated tRPC bundle.
          const { resolveActiveTrengoConversation } = await import(
            '@studymind/integration-trengo/conversations'
          )
          const conv = await resolveActiveTrengoConversation(ctx.db, seed.contactId)
          if (ticketId === null && conv) ticketId = conv.ticketId
          if (channel === null && conv && conv.ticketId === ticketId) {
            channel = conv.channel
          }
        }
        if (ticketId === null) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No open Trengo conversation for this contact to reply on.',
          })
        }
        if (channel === null) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'Could not determine this conversation’s channel — open it in Trengo once, or reply from there.',
          })
        }

        const { sendMessage } = await import('@studymind/integration-trengo/outbound')
        try {
          const result = await sendMessage({
            contactId: seed.contactId,
            agentId: user.id,
            ticketId,
            channel,
            body: input.body,
            requestId: ctx.requestId,
            ...(attachments.length > 0 ? { attachments } : {}),
          })

          await ctx.audit({
            action: 'trengo.reply_requested',
            target: { type: 'Contact', id: seed.contactId },
            after: {
              interactionId: result.interactionId,
              trengoMessageId: result.trengoMessageId,
              ticketId,
              channel,
            },
          })

          return {
            interactionId: result.interactionId,
            trengoMessageId: result.trengoMessageId,
            channel,
          }
        } catch (err) {
          // The Interaction stays in `pending_send` (handled inside
          // sendMessage) so the reply is recoverable. Surface a clean,
          // non-paging error to the agent (a Trengo hiccup is not our bug).
          if (err instanceof BusinessError && err.code === 'TOKEN_EXPIRED') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message:
                'Your Trengo token has expired — reconnect it in Account → Trengo to send.',
            })
          }
          const name = err instanceof Error ? err.name : ''
          if (err instanceof BusinessError || name === 'TrengoApiError') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'Trengo could not accept the reply right now. It is saved — try again shortly.',
            })
          }
          throw err
        }
      }),

    // ADR 0020 Phase 6j — start a brand-new conversation with a contact who
    // has no open ticket. Resolves the recipient from the contact (phone for
    // whatsapp/sms, email for email), creates the Trengo conversation, and
    // mirrors a head so it shows in the inbox at once. Sales Executive+.
    startConversation: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          channel: z.enum(['whatsapp', 'sms', 'email', 'web_chat']),
          /** Exact Trengo channel (sender line) to send from — workspaces run
           *  several channels per type, and an unpicked send went from an
           *  arbitrary one. */
          trengoChannelId: z.number().int().positive().optional(),
          body: z.string().trim().min(1).max(4_000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (
          !['ceo', 'senior_manager', 'manager', 'sales_executive'].includes(user.role)
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'role cannot send messages' })
        }
        await enforceRestrictedAccess(ctx, input.contactId, 'trengo-start')

        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true, phoneE164: true, email: true },
        })
        if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })

        const recipient =
          input.channel === 'email' ? contact.email : contact.phoneE164
        if (!recipient) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              input.channel === 'email'
                ? 'This contact has no email address.'
                : 'This contact has no phone number.',
          })
        }

        const { startConversation } = await import(
          '@studymind/integration-trengo/outbound'
        )
        try {
          const result = await startConversation({
            contactId: contact.id,
            agentId: user.id,
            channel: input.channel,
            ...(input.trengoChannelId
              ? { trengoChannelId: input.trengoChannelId }
              : {}),
            recipient,
            body: input.body,
            requestId: ctx.requestId,
          })
          await ctx.audit({
            action: 'trengo.reply_requested',
            target: { type: 'Contact', id: contact.id },
            after: {
              interactionId: result.interactionId,
              ticketId: result.ticketId,
              channel: input.channel,
              newConversation: true,
            },
          })
          return result
        } catch (err) {
          throw mapTrengoOutboundError(err)
        }
      }),

    // Start a brand-new WhatsApp conversation with an APPROVED Trengo template
    // (HSM) — the same thing Trengo's own composer does, and the only send
    // WhatsApp accepts outside the 24-hour window. The UI fills the {{n}}
    // params with a live preview; we receive the param values plus the
    // rendered body for the timeline. Sales Executive+.
    startWhatsappTemplate: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          templateId: z.number().int().positive(),
          templateTitle: z.string().trim().min(1).max(200),
          params: z
            .array(
              z.object({
                key: z.string().min(1).max(12),
                value: z.string().trim().min(1).max(500),
              }),
            )
            .max(20),
          renderedBody: z.string().trim().min(1).max(4_000),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (
          !['ceo', 'senior_manager', 'manager', 'sales_executive'].includes(user.role)
        ) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'role cannot send messages' })
        }
        await enforceRestrictedAccess(ctx, input.contactId, 'trengo-start-template')

        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true, phoneE164: true },
        })
        if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
        if (!contact.phoneE164) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This contact has no phone number.',
          })
        }

        const { sendWhatsAppTemplate } = await import(
          '@studymind/integration-trengo/outbound'
        )
        try {
          const result = await sendWhatsAppTemplate({
            contactId: contact.id,
            agentId: user.id,
            recipient: contact.phoneE164,
            templateId: input.templateId,
            templateTitle: input.templateTitle,
            renderedBody: input.renderedBody,
            params: input.params,
            requestId: ctx.requestId,
          })
          await ctx.audit({
            action: 'trengo.reply_requested',
            target: { type: 'Contact', id: contact.id },
            after: {
              interactionId: result.interactionId,
              waTemplateId: input.templateId,
              channel: 'whatsapp',
              newConversation: true,
            },
          })
          return result
        } catch (err) {
          throw mapTrengoOutboundError(err)
        }
      }),

    // Trengo quick replies (canned responses) — surfaced as the SMS
    // "templates" in the new-conversation composer. Graceful: a missing token
    // returns available:false instead of erroring, so the UI falls back to
    // free text.
    /** The workspace's Trengo channels (sender lines/mailboxes) — drives the
     *  composer's "send from" picker. Graceful: no token → available:false. */
    channels: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      const { listTrengoChannels } = await import(
        '@studymind/integration-trengo/outbound'
      )
      return listTrengoChannels(user.id, ctx.requestId)
    }),

    quickReplies: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      try {
        const { listTrengoQuickReplies } = await import(
          '@studymind/integration-trengo/outbound'
        )
        const replies = await listTrengoQuickReplies(user.id, ctx.requestId)
        return { available: true as const, replies }
      } catch (err) {
        const reason =
          err instanceof BusinessError && err.code === 'TOKEN_EXPIRED'
            ? 'Connect your Trengo token in Account → Trengo to load quick replies.'
            : 'Could not load quick replies from Trengo.'
        return {
          available: false as const,
          reason,
          replies: [] as Array<{ id: number; title: string; body: string }>,
        }
      }
    }),

    // CLAUDE.md §11 — close / reopen a Trengo conversation from the CRM.
    // Reuses the new audited `closeConversation` / `reopenConversation`
    // outbound, which writes a CRM-sourced Interaction the inbound webhook
    // echo then links to (no duplicate Interactions). Virtual Assistants
    // cannot trigger state changes.
    close: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          ticketId: z.number().int().positive(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        gateTrengoStateChange(user.role)
        await enforceRestrictedAccess(ctx, input.contactId, 'trengo-close')
        const { closeConversation } = await import(
          '@studymind/integration-trengo/outbound'
        )
        return runTrengoStateChange({
          action: 'close',
          run: () =>
            closeConversation({
              contactId: input.contactId,
              agentId: user.id,
              ticketId: input.ticketId,
              requestId: ctx.requestId,
            }),
          audit: (interactionId) =>
            ctx.audit({
              action: 'trengo.ticket_close_requested',
              target: { type: 'Contact', id: input.contactId },
              after: { interactionId, ticketId: input.ticketId },
            }),
        })
      }),

    reopen: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          ticketId: z.number().int().positive(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        gateTrengoStateChange(user.role)
        await enforceRestrictedAccess(ctx, input.contactId, 'trengo-reopen')
        const { reopenConversation } = await import(
          '@studymind/integration-trengo/outbound'
        )
        return runTrengoStateChange({
          action: 'reopen',
          run: () =>
            reopenConversation({
              contactId: input.contactId,
              agentId: user.id,
              ticketId: input.ticketId,
              requestId: ctx.requestId,
            }),
          audit: (interactionId) =>
            ctx.audit({
              action: 'trengo.ticket_reopen_requested',
              target: { type: 'Contact', id: input.contactId },
              after: { interactionId, ticketId: input.ticketId },
            }),
        })
      }),

    // ADR 0020 Phase 6e — assign a conversation to a CRM teammate from the
    // Comms Centre. Routes through Trengo (assignTicket) using the target's
    // User.trengoUserId (Phase 6a). Manager+ only — reassigning ownership is
    // a supervisory action.
    assign: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          ticketId: z.number().int().positive(),
          assigneeUserId: z.string().min(1),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (
          !['ceo', 'senior_manager', 'manager'].includes(user.role)
        ) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only Manager and above can reassign conversations.',
          })
        }
        await enforceRestrictedAccess(ctx, input.contactId, 'trengo-assign')
        const { assignConversation } = await import(
          '@studymind/integration-trengo/outbound'
        )
        try {
          const result = await assignConversation({
            contactId: input.contactId,
            agentId: user.id,
            ticketId: input.ticketId,
            assigneeUserId: input.assigneeUserId,
            requestId: ctx.requestId,
          })
          await ctx.audit({
            action: 'trengo.ticket_assign_requested',
            target: { type: 'Contact', id: input.contactId },
            after: {
              interactionId: result.interactionId,
              ticketId: input.ticketId,
              assigneeUserId: input.assigneeUserId,
            },
          })
          return result
        } catch (err) {
          if (err instanceof BusinessError && err.code === 'TOKEN_EXPIRED') {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message:
                'Your Trengo token has expired — reconnect it in Account → Trengo to assign.',
            })
          }
          if (
            err instanceof BusinessError &&
            (err.code === 'NO_TRENGO_IDENTITY' || err.code === 'UNKNOWN_USER')
          ) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
          }
          const name = err instanceof Error ? err.name : ''
          if (err instanceof BusinessError || name === 'TrengoApiError') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Trengo could not accept the assignment right now. Try again shortly.',
            })
          }
          throw err
        }
      }),

    /** Users who can be assigned a Trengo conversation — i.e. those with a
     *  Trengo identity (User.trengoUserId). Drives the assignee picker. */
    assignableUsers: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!['ceo', 'senior_manager', 'manager'].includes(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const rows = await ctx.db.user.findMany({
        where: { trengoUserId: { not: null }, isActive: true, deletedAt: null },
        orderBy: [{ name: 'asc' }, { email: 'asc' }],
        select: { id: true, name: true, email: true },
      })
      return rows.map((r) => ({ id: r.id, name: r.name ?? r.email }))
    }),

    // ADR 0020 Phase 6f — label (tag) add / remove on a conversation, synced
    // to Trengo. Completes the brief's bi-directional tag management. Sales
    // Executive+.
    addLabel: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          ticketId: z.number().int().positive(),
          label: z.string().trim().min(1).max(80),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        gateTrengoStateChange(user.role)
        await enforceRestrictedAccess(ctx, input.contactId, 'trengo-label')
        const { addConversationLabel } = await import(
          '@studymind/integration-trengo/outbound'
        )
        return runTrengoLabel({
          run: () =>
            addConversationLabel({
              contactId: input.contactId,
              agentId: user.id,
              ticketId: input.ticketId,
              label: input.label,
              requestId: ctx.requestId,
            }),
          audit: (interactionId) =>
            ctx.audit({
              action: 'trengo.label_add_requested',
              target: { type: 'Contact', id: input.contactId },
              after: { interactionId, ticketId: input.ticketId, label: input.label },
            }),
        })
      }),

    removeLabel: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          ticketId: z.number().int().positive(),
          label: z.string().trim().min(1).max(80),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        gateTrengoStateChange(user.role)
        await enforceRestrictedAccess(ctx, input.contactId, 'trengo-label')
        const { removeConversationLabel } = await import(
          '@studymind/integration-trengo/outbound'
        )
        return runTrengoLabel({
          run: () =>
            removeConversationLabel({
              contactId: input.contactId,
              agentId: user.id,
              ticketId: input.ticketId,
              label: input.label,
              requestId: ctx.requestId,
            }),
          audit: (interactionId) =>
            ctx.audit({
              action: 'trengo.label_remove_requested',
              target: { type: 'Contact', id: input.contactId },
              after: { interactionId, ticketId: input.ticketId, label: input.label },
            }),
        })
      }),

    /** The agent's Trengo label catalogue — drives the label picker. */
    availableLabels: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (
        !['ceo', 'senior_manager', 'manager', 'sales_executive'].includes(user.role)
      ) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }
      const { listTrengoLabels } = await import(
        '@studymind/integration-trengo/outbound'
      )
      try {
        return await listTrengoLabels(user.id, ctx.requestId)
      } catch {
        // No token / Trengo down — return empty so the picker degrades to a
        // free-text entry rather than erroring the whole thread.
        return []
      }
    }),

    // ADR 0020 Phase 6f — clear a conversation's unread count (CRM-side head
    // state; Trengo's own read state is not exposed for write). Internal
    // notes go through the unified `inbox.conversations.notes.add` (which adds
    // @mentions and pushes to Trengo for Trengo tickets).
    markRead: auditedProcedure
      .input(z.object({ conversationId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (
          !['ceo', 'senior_manager', 'manager', 'sales_executive', 'virtual_assistant'].includes(
            user.role,
          )
        ) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
        const conv = await ctx.db.conversation.findUnique({
          where: { id: input.conversationId },
          select: { id: true, contactId: true, unreadCount: true },
        })
        if (!conv) throw new TRPCError({ code: 'NOT_FOUND' })
        if (conv.unreadCount > 0) {
          await ctx.db.conversation.update({
            where: { id: conv.id },
            data: { unreadCount: 0 },
          })
        }
        await ctx.audit({
          action: 'trengo.conversation_read',
          target: conv.contactId
            ? { type: 'Contact', id: conv.contactId }
            : { type: 'Conversation', id: conv.id },
          after: { conversationId: conv.id },
        })
        return { ok: true as const }
      }),

    // Mark a conversation UNREAD — bumps the head's unread count so it
    // re-surfaces in the "Unanswered" view (Trengo parity). CRM-side head
    // state; any staff may triage.
    markUnread: auditedProcedure
      .input(z.object({ conversationId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!INBOX_STAFF_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
        const conv = await ctx.db.conversation.findUnique({
          where: { id: input.conversationId },
          select: { id: true, contactId: true, unreadCount: true },
        })
        if (!conv) throw new TRPCError({ code: 'NOT_FOUND' })
        if (conv.unreadCount === 0) {
          await ctx.db.conversation.update({
            where: { id: conv.id },
            data: { unreadCount: 1 },
          })
        }
        await ctx.audit({
          action: 'trengo.conversation_unread',
          target: conv.contactId
            ? { type: 'Contact', id: conv.contactId }
            : { type: 'Conversation', id: conv.id },
          after: { conversationId: conv.id },
        })
        return { ok: true as const }
      }),

    // ADR 0020 Phase 6g — snooze a conversation: hide it from the active
    // inbox until `minutes` from now. The `trengo/unsnooze-due` cron (and a
    // new inbound) resurface it. CRM-side head state — any staff may triage.
    snooze: auditedProcedure
      .input(
        z.object({
          conversationId: z.string().min(1),
          minutes: z.number().int().min(5).max(60 * 24 * 30),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!INBOX_STAFF_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
        const conv = await ctx.db.conversation.findUnique({
          where: { id: input.conversationId },
          select: { id: true, contactId: true },
        })
        if (!conv) throw new TRPCError({ code: 'NOT_FOUND' })
        const until = new Date(Date.now() + input.minutes * 60_000)
        await ctx.db.conversation.update({
          where: { id: conv.id },
          data: { status: 'snoozed', snoozedUntil: until },
        })
        const { publishConversationUpdate } = await import('@studymind/core/realtime')
        publishConversationUpdate({
          id: conv.id,
          trengoTicketId: null,
          lastMessageAt: null,
          contactId: conv.contactId,
        })
        await ctx.audit({
          action: 'trengo.conversation_snoozed',
          target: conv.contactId
            ? { type: 'Contact', id: conv.contactId }
            : { type: 'Conversation', id: conv.id },
          after: { conversationId: conv.id, snoozedUntil: until.toISOString() },
        })
        return { ok: true as const, snoozedUntil: until.toISOString() }
      }),

    /** Bring a snoozed conversation back to the active inbox now. */
    unsnooze: auditedProcedure
      .input(z.object({ conversationId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        if (!INBOX_STAFF_ROLES.has(user.role)) {
          throw new TRPCError({ code: 'FORBIDDEN' })
        }
        const conv = await ctx.db.conversation.findUnique({
          where: { id: input.conversationId },
          select: { id: true, contactId: true, status: true },
        })
        if (!conv) throw new TRPCError({ code: 'NOT_FOUND' })
        if (conv.status === 'snoozed') {
          await ctx.db.conversation.update({
            where: { id: conv.id },
            data: { status: 'open', snoozedUntil: null },
          })
        }
        const { publishConversationUpdate } = await import('@studymind/core/realtime')
        publishConversationUpdate({
          id: conv.id,
          trengoTicketId: null,
          lastMessageAt: null,
          contactId: conv.contactId,
        })
        await ctx.audit({
          action: 'trengo.conversation_unsnoozed',
          target: conv.contactId
            ? { type: 'Contact', id: conv.contactId }
            : { type: 'Conversation', id: conv.id },
          after: { conversationId: conv.id },
        })
        return { ok: true as const }
      }),
  }),
})

const INBOX_STAFF_ROLES: ReadonlySet<string> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

interface RunTrengoLabelInput<R extends { interactionId: string }> {
  run: () => Promise<R>
  audit: (interactionId: string) => Promise<string>
}

async function runTrengoLabel<R extends { interactionId: string }>(
  input: RunTrengoLabelInput<R>,
): Promise<R> {
  try {
    const result = await input.run()
    await input.audit(result.interactionId)
    return result
  } catch (err) {
    throw mapTrengoOutboundError(err)
  }
}

/** Map a Trengo outbound BusinessError / API error to a clean tRPC error. */
function mapTrengoOutboundError(err: unknown): TRPCError {
  if (err instanceof BusinessError && err.code === 'TOKEN_EXPIRED') {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your Trengo token has expired — reconnect it in Account → Trengo.',
    })
  }
  const name = err instanceof Error ? err.name : ''
  if (err instanceof BusinessError || name === 'TrengoApiError') {
    return new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Trengo could not complete that action right now. Try again shortly.',
    })
  }
  if (err instanceof TRPCError) return err
  return new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unexpected error' })
}

function gateTrengoStateChange(role: string): void {
  if (
    !['ceo', 'senior_manager', 'manager', 'sales_executive'].includes(role)
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'role cannot change conversation state',
    })
  }
}

interface RunTrengoStateChangeInput<R extends { interactionId: string }> {
  action: 'close' | 'reopen'
  run: () => Promise<R>
  audit: (interactionId: string) => Promise<string>
}

async function runTrengoStateChange<R extends { interactionId: string }>(
  input: RunTrengoStateChangeInput<R>,
): Promise<R> {
  try {
    const result = await input.run()
    await input.audit(result.interactionId)
    return result
  } catch (err) {
    if (err instanceof BusinessError && err.code === 'TOKEN_EXPIRED') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message:
          'Your Trengo token has expired — reconnect it in Account → Trengo to act on conversations.',
      })
    }
    const name = err instanceof Error ? err.name : ''
    if (err instanceof BusinessError || name === 'TrengoApiError') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          input.action === 'close'
            ? 'Trengo could not close the conversation right now. Try again shortly.'
            : 'Trengo could not reopen the conversation right now. Try again shortly.',
      })
    }
    throw err
  }
}

/**
 * For a family-scoped list, return the contact ids whose timeline rows must
 * be hidden from this caller because they are restricted_access and the
 * caller is neither admin nor the assigned DSL on every such row.
 *
 * When called without a familyId (or when the caller is admin) returns [].
 */
async function getRestrictedContactIdsToHide(
  _ctx: Parameters<typeof enforceRestrictedAccess>[0],
  _familyId: string | undefined,
): Promise<string[]> {
  // Safeguarding restricted-access enforcement was removed in ADR 0013.
  // Helper retained as a no-op extension point.
  return []
}

// Map the Prisma enum (uses underscores) to our domain enum (uses dots where
// the event taxonomy demands it). See CLAUDE.md §45.
function mapDbType(t: string): InteractionListItem['type'] {
  switch (t) {
    case 'note':
      return 'note'
    case 'call':
      return 'call'
    case 'email':
      return 'email_sent'
    case 'email_received':
      return 'email_received'
    case 'email_sent':
      return 'email_sent'
    case 'booking':
      return 'booking'
    case 'family_state_changed':
      return 'family.state_changed'
    case 'family_billing_contact_changed':
      return 'family.billing_contact_changed'
    case 'safeguarding_concern_raised':
      return 'safeguarding.concern_raised'
    // Pass-throughs so the timeline can label rows truthfully — these used to
    // collapse to 'note', which made messages, card events, call summaries and
    // web enquiries all read "note" on the Activity timeline.
    case 'message':
    case 'ticket_assigned':
    case 'ticket_closed':
    case 'ticket_reopened':
    case 'label_added':
    case 'label_removed':
    case 'card_moved':
    case 'card_comment':
    case 'card_description_changed':
    case 'call_summary':
    case 'call_summary_sent':
    case 'task_comment':
    case 'lead_enquiry':
    case 'email_forwarded':
    case 'slack_summary':
    case 'payment':
    case 'family_pipeline_moved':
      return t
    default:
      return 'note'
  }
}
