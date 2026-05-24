// Per-channel router for the comprehensive customer view (ADR 0017).
// Each procedure pages over a single channel (email threads, calls, slack
// mentions, trengo conversations, tasks, notes) and returns the typed
// view-model shape from `apps/web/lib/view-models/contact-channels.ts`.
//
// Read-only — no audit calls. Reads of contact channel data carry no
// safeguarding flag of their own; the page-level `contact.get` is the
// gate that enforces restricted-access semantics for the contact itself.
//
// CLAUDE.md §26, §27.

import { z } from 'zod'

import {
  callsForContact,
  channelSummaryForContact,
  emailThreadsForContact,
  notesForContact,
  searchAcrossChannels,
  slackMentionsForContact,
  tasksForContact,
  trengoConversationsForContact,
} from '@/lib/view-models/contact-channels'

import { protectedProcedure, router } from '@/lib/trpc/builders'

const ChannelListInput = z.object({
  contactId: z.string().min(1),
  cursor: z
    .object({ id: z.string(), occurredAt: z.date() })
    .nullish(),
  limit: z.number().min(1).max(100).default(25),
})

const ContactOnlyInput = z.object({ contactId: z.string().min(1) })

const SearchInput = z.object({
  contactId: z.string().min(1),
  q: z.string().trim().min(2).max(120),
})

export const contactChannelsRouter = router({
  emailThreads: protectedProcedure
    .input(ChannelListInput)
    .query(({ ctx, input }) =>
      emailThreadsForContact(ctx.db, {
        contactId: input.contactId,
        limit: input.limit,
        cursor: input.cursor ?? null,
      }),
    ),

  calls: protectedProcedure
    .input(ChannelListInput)
    .query(({ ctx, input }) =>
      callsForContact(ctx.db, {
        contactId: input.contactId,
        limit: input.limit,
        cursor: input.cursor ?? null,
      }),
    ),

  slackMentions: protectedProcedure
    .input(ChannelListInput)
    .query(({ ctx, input }) =>
      slackMentionsForContact(ctx.db, {
        contactId: input.contactId,
        limit: input.limit,
        cursor: input.cursor ?? null,
      }),
    ),

  trengoConversations: protectedProcedure
    .input(ChannelListInput)
    .query(({ ctx, input }) =>
      trengoConversationsForContact(ctx.db, {
        contactId: input.contactId,
        limit: input.limit,
        cursor: input.cursor ?? null,
      }),
    ),

  tasks: protectedProcedure
    .input(ContactOnlyInput)
    .query(({ ctx, input }) => tasksForContact(ctx.db, input)),

  notes: protectedProcedure
    .input(ChannelListInput)
    .query(({ ctx, input }) =>
      notesForContact(ctx.db, {
        contactId: input.contactId,
        limit: input.limit,
        cursor: input.cursor ?? null,
      }),
    ),

  search: protectedProcedure
    .input(SearchInput)
    .query(({ ctx, input }) =>
      searchAcrossChannels(ctx.db, input.contactId, input.q),
    ),

  summary: protectedProcedure
    .input(ContactOnlyInput)
    .query(({ ctx, input }) => channelSummaryForContact(ctx.db, input.contactId)),
})
