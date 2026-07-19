// Forwarding tRPC router. Two surfaces:
//
//   forwarding.rules.* — CRUD for the rule catalogue (Manager+).
//   forwarding.preview — render a rule against a contact for the modal.
//   forwarding.send    — send via the rule, recording an `email_forwarded`
//                        Interaction on the contact. Sales Executive+;
//                        Virtual Assistant is read-only.
//
// CLAUDE.md §20.1, §27.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ForwardingRuleCreateInput,
  ForwardingRuleUpdateInput,
  ForwardingSendInput,
  buildTemplateContext,
  forwardEmail,
  renderRule,
} from '@studymind/core/forwarding'
import { BusinessError } from '@studymind/core/errors'

import { buildForwardingSender } from '@/lib/forwarding/senders'
import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

function mapBusinessError(err: unknown): never {
  if (err instanceof BusinessError) {
    switch (err.code) {
      case 'FORWARDING_RULE_NOT_FOUND':
      case 'CONTACT_NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
      case 'FORWARDING_RULE_ARCHIVED':
      case 'CONTACT_RESTRICTED':
        throw new TRPCError({ code: 'FORBIDDEN', message: err.message })
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    }
  }
  throw err
}

const RULE_MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

const SEND_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

function assertCanManageRules(role: UserRole): void {
  if (!RULE_MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager or above can manage forwarding rules',
    })
  }
}

function assertCanSend(role: UserRole): void {
  if (!SEND_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Virtual Assistants cannot send forwarded emails',
    })
  }
}

function appUrl(): string {
  return (
    process.env['NEXT_PUBLIC_APP_URL'] ??
    process.env['APP_URL'] ??
    'http://localhost:3000'
  ).replace(/\/$/, '')
}

const rulesRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({ includeArchived: z.boolean().default(false) })
        .default({ includeArchived: false }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.forwardingRule.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
      })
      return rows.map((r) => ({
        id: r.id,
        key: r.key,
        label: r.label,
        description: r.description,
        toAddresses: r.toAddresses,
        ccAddresses: r.ccAddresses,
        bccAddresses: r.bccAddresses,
        subjectTemplate: r.subjectTemplate,
        bodyTemplate: r.bodyTemplate,
        sortOrder: r.sortOrder,
        archived: r.archivedAt != null,
      }))
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.forwardingRule.findUnique({ where: { id: input.id } })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      return {
        id: row.id,
        key: row.key,
        label: row.label,
        description: row.description,
        toAddresses: row.toAddresses,
        ccAddresses: row.ccAddresses,
        bccAddresses: row.bccAddresses,
        subjectTemplate: row.subjectTemplate,
        bodyTemplate: row.bodyTemplate,
        sortOrder: row.sortOrder,
        archived: row.archivedAt != null,
      }
    }),

  create: auditedProcedure
    .input(ForwardingRuleCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageRules(user.role)
      const id = createId()
      const created = await ctx.db.forwardingRule.create({
        data: {
          id,
          key: input.key,
          label: input.label,
          description: input.description ?? null,
          toAddresses: input.toAddresses,
          ccAddresses: input.ccAddresses,
          bccAddresses: input.bccAddresses,
          subjectTemplate: input.subjectTemplate,
          bodyTemplate: input.bodyTemplate,
          sortOrder: input.sortOrder ?? 100,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'forwarding.rule_created',
        target: { type: 'ForwardingRule', id: created.id },
        after: created,
      })
      return { id: created.id }
    }),

  update: auditedProcedure
    .input(ForwardingRuleUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageRules(user.role)
      const before = await ctx.db.forwardingRule.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.forwardingRule.update({
        where: { id: input.id },
        data: {
          label: input.label ?? undefined,
          description: input.description,
          toAddresses: input.toAddresses ?? undefined,
          ccAddresses: input.ccAddresses ?? undefined,
          bccAddresses: input.bccAddresses ?? undefined,
          subjectTemplate: input.subjectTemplate ?? undefined,
          bodyTemplate: input.bodyTemplate ?? undefined,
          sortOrder: input.sortOrder ?? undefined,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'forwarding.rule_updated',
        target: { type: 'ForwardingRule', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageRules(user.role)
      const before = await ctx.db.forwardingRule.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.forwardingRule.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'forwarding.rule_archived',
        target: { type: 'ForwardingRule', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageRules(user.role)
      const before = await ctx.db.forwardingRule.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.forwardingRule.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'forwarding.rule_restored',
        target: { type: 'ForwardingRule', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),
})

export const forwardingRouter = router({
  rules: rulesRouter,

  /**
   * Render the rule's subject/body against a contact, so the modal shows the
   * agent what will be sent before they edit. Pure read.
   */
  preview: protectedProcedure
    .input(
      z.object({
        contactId: z.string(),
        ruleId: z.string(),
        notes: z.string().max(10_000).default(''),
      }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const rule = await ctx.db.forwardingRule.findUnique({ where: { id: input.ruleId } })
      if (!rule) throw new TRPCError({ code: 'NOT_FOUND', message: 'Rule not found' })
      const contact = await ctx.db.contact.findFirst({
        where: { id: input.contactId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneE164: true,
          familyMembers: {
            take: 1,
            select: { family: { select: { name: true } } },
          },
        },
      })
      if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
      const family = contact.familyMembers[0]?.family ?? null
      const actor = await ctx.db.user.findUnique({
        where: { id: user.id },
        select: { email: true, name: true },
      })

      const tctx = buildTemplateContext({
        appUrl: appUrl(),
        contact,
        family: family ? { name: family.name } : null,
        agent: { name: actor?.name ?? null, email: actor?.email ?? user.email },
        notes: input.notes,
      })
      const { subject, body } = renderRule(rule, tctx)
      return {
        ruleId: rule.id,
        ruleKey: rule.key,
        ruleLabel: rule.label,
        toAddresses: rule.toAddresses,
        ccAddresses: rule.ccAddresses,
        bccAddresses: rule.bccAddresses,
        subject,
        body,
      }
    }),

  /** Actually send the forward. Records `email_forwarded` Interaction. */
  send: auditedProcedure
    .input(ForwardingSendInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanSend(user.role)
      const actor = await ctx.db.user.findUnique({
        where: { id: user.id },
        select: { email: true },
      })
      const sender = buildForwardingSender({ agentEmail: actor?.email ?? user.email })

      try {
        const result = await forwardEmail(
          ctx.db,
          {
            contactId: input.contactId,
            ruleId: input.ruleId,
            subject: input.subject,
            body: input.body,
            sender,
          },
          { actorId: user.id, requestId: ctx.requestId },
        )
        // forwardEmail wrote the audit row directly; mark the middleware
        // happy (same pattern as board.callSummary.send).
        ctx.audit.called = true
        return result
      } catch (err) {
        mapBusinessError(err)
      }
    }),
})
