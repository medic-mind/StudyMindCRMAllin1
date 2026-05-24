// Family router. See CLAUDE.md Sections 6.1, 27, 41.1.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  FamilyCreateInput,
  FamilyLinkContactInput,
  FamilySetBillingContactInput,
  assertBillingContactNotStudent,
} from '@studymind/core/family'
import { reconcileFamily } from '@studymind/core/finance'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

function newId(): string {
  return createId()
}

const FAMILY_STATES = ['lead', 'trial', 'active', 'at_risk', 'churned'] as const
type FamilyState = (typeof FAMILY_STATES)[number]

const PipelineListInput = z.object({
  /** Optional: limit the result to a single stage. */
  state: z.enum(FAMILY_STATES).optional(),
  /** Cap per stage so the kanban view stays bounded. */
  perStageLimit: z.number().min(1).max(200).default(100),
})

export const familyRouter = router({
  pipeline: router({
    /**
     * Returns Families grouped by lifecycle state for the pipeline kanban.
     * CLAUDE.md §6.4. View-model — never raw rows.
     */
    list: protectedProcedure.input(PipelineListInput).query(async ({ ctx, input }) => {
      const states: readonly FamilyState[] = input.state ? [input.state] : FAMILY_STATES
      const groups = await Promise.all(
        states.map(async (state) => {
          const rows = await ctx.db.family.findMany({
            where: { state, deletedAt: null },
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            take: input.perStageLimit,
            select: {
              id: true,
              name: true,
              state: true,
              stageId: true,
              billingParty: true,
              churnScore: true,
              updatedAt: true,
            },
          })
          return [state, rows] as const
        }),
      )
      return Object.fromEntries(groups) as Record<FamilyState, (typeof groups)[number][1]>
    }),

    /**
     * Most recent family.state_changed Interactions across the given Family
     * ids. Used by the pipeline page side-panel.
     */
    recentTransitions: protectedProcedure
      .input(z.object({ familyIds: z.array(z.string()).max(500), limit: z.number().min(1).max(50).default(5) }))
      .query(async ({ ctx, input }) => {
        if (input.familyIds.length === 0) return []
        const rows = await ctx.db.interaction.findMany({
          where: {
            type: 'family_state_changed',
            familyId: { in: input.familyIds },
            deletedAt: null,
          },
          orderBy: { occurredAt: 'desc' },
          take: input.limit,
          select: { id: true, occurredAt: true, summary: true, familyId: true },
        })
        return rows
      }),

    // ADR 0015: the enum-based `transition` mutation has been replaced by
    // `pipeline.family.move`. The list and recentTransitions queries remain
    // because the at-risk derivation and reports still surface the legacy
    // family_state_changed interactions written by the at-risk job.
  }),

  create: auditedProcedure
    .input(FamilyCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const id = newId()
      // ADR 0015: assign the new family to the first non-closed, lowest-
      // position stage by default. If no active stages exist yet, leave
      // stageId null — the family will surface in the "Unassigned" tray
      // on the pipeline kanban.
      const defaultStage = await ctx.db.pipelineStage.findFirst({
        where: { archivedAt: null, isClosed: false },
        orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
        select: { id: true },
      })
      const family = await ctx.db.family.create({
        data: {
          id,
          name: input.name ?? null,
          billingParty: input.billingParty,
          billingContactId: input.billingContactId ?? null,
          stageId: defaultStage?.id ?? null,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'family.created',
        target: { type: 'Family', id: family.id },
        before: null,
        after: family,
      })
      return { id: family.id }
    }),

  linkContact: auditedProcedure
    .input(FamilyLinkContactInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // Enforce invariant: if linking as student, ensure not the billing contact.
      const family = await ctx.db.family.findFirst({
        where: { id: input.familyId, deletedAt: null },
        include: {
          members: { select: { contactId: true, role: true } },
        },
      })
      if (!family) throw new TRPCError({ code: 'NOT_FOUND' })

      const proposed = [
        ...family.members.map((m) => ({
          contactId: m.contactId,
          role: m.role as 'billing' | 'student' | 'guardian' | 'other',
        })),
        { contactId: input.contactId, role: input.role },
      ]
      try {
        assertBillingContactNotStudent(family.billingContactId, proposed)
      } catch (err) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: err instanceof Error ? err.message : 'invariant violation',
        })
      }

      const link = await ctx.db.familyMember.upsert({
        where: {
          familyId_contactId: { familyId: input.familyId, contactId: input.contactId },
        },
        create: {
          id: newId(),
          familyId: input.familyId,
          contactId: input.contactId,
          role: input.role,
          createdById: user.id,
          updatedById: user.id,
        },
        update: {
          role: input.role,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'family.contact_linked',
        target: { type: 'Family', id: input.familyId },
        before: null,
        after: link,
      })
      return { id: link.id }
    }),

  setBillingContact: auditedProcedure
    .input(FamilySetBillingContactInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const family = await ctx.db.family.findFirst({
        where: { id: input.familyId, deletedAt: null },
        include: { members: { select: { contactId: true, role: true } } },
      })
      if (!family) throw new TRPCError({ code: 'NOT_FOUND' })

      try {
        assertBillingContactNotStudent(
          input.newBillingContactId,
          family.members.map((m) => ({
            contactId: m.contactId,
            role: m.role as 'billing' | 'student' | 'guardian' | 'other',
          })),
        )
      } catch (err) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: err instanceof Error ? err.message : 'invariant violation',
        })
      }

      const previousId = family.billingContactId

      const updated = await ctx.db.$transaction(async (tx) => {
        const next = await tx.family.update({
          where: { id: input.familyId },
          data: {
            billingContactId: input.newBillingContactId,
            updatedById: user.id,
          },
        })
        await tx.interaction.create({
          data: {
            id: newId(),
            type: 'family_billing_contact_changed',
            familyId: input.familyId,
            occurredAt: input.effectiveDate ?? new Date(),
            summary: `Billing contact changed: ${input.reason}`,
            payload: {
              previousContactId: previousId,
              newContactId: input.newBillingContactId,
              reason: input.reason,
              effectiveDate: input.effectiveDate?.toISOString() ?? null,
            },
            createdById: user.id,
            updatedById: user.id,
          },
        })
        return next
      })

      await ctx.audit({
        action: 'family.billing_contact_changed',
        target: { type: 'Family', id: input.familyId },
        before: { billingContactId: previousId },
        after: { billingContactId: updated.billingContactId, reason: input.reason },
      })
      return { id: updated.id }
    }),

  /**
   * Manual reconcile of a single Family. CLAUDE.md §6.3, §17. Mirrors the
   * idempotent upsert in the nightly job. Role-gated to ceo, senior_manager,
   * and manager — anyone reviewing a family's books can re-run the engine on
   * demand. Audited. ADR 0014.
   */
  reconcile: auditedProcedure
    .input(z.object({ familyId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const allowed: ReadonlySet<UserRole> = new Set([
        'ceo',
        'senior_manager',
        'manager',
      ])
      if (!allowed.has(user.role)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'role cannot reconcile' })
      }
      const family = await ctx.db.family.findFirst({
        where: { id: input.familyId, deletedAt: null },
        select: { id: true },
      })
      if (!family) throw new TRPCError({ code: 'NOT_FOUND' })
      const { discrepancies } = await reconcileFamily(ctx.db, family.id)
      let created = 0
      for (const d of discrepancies) {
        const existing = await ctx.db.reconciliationDiscrepancy.findFirst({
          where: {
            familyId: d.familyId,
            category: d.category,
            contextHash: d.contextHash,
          },
          select: { id: true },
        })
        if (existing) continue
        await ctx.db.reconciliationDiscrepancy.create({
          data: {
            id: newId(),
            familyId: d.familyId,
            category: d.category,
            summary: d.summary,
            payload: d.payload as object,
            contextHash: d.contextHash,
          },
        })
        created += 1
      }
      await ctx.audit({
        action: 'finance.family_reconciled',
        target: { type: 'Family', id: family.id },
        after: { discrepancies: discrepancies.length, created },
      })
      return { discrepancies: discrepancies.length, created }
    }),

  get: protectedProcedure
    // Read endpoint. Reads of minor data carry an audit obligation per §20; this
    // is enforced at the field level in a follow-up PR (encrypted notes path).
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const f = await ctx.db.family.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          members: {
            include: { contact: { select: { id: true, firstName: true, lastName: true, isMinor: true } } },
          },
        },
      })
      if (!f) throw new TRPCError({ code: 'NOT_FOUND' })
      return f
    }),

  /**
   * View-model for the Family detail page. Returns a shaped object — never
   * the raw row — and includes AP placement, open discrepancies, and recent
   * timeline entries. CLAUDE.md §26 (RSC ↔ client data boundary), §43.4.
   */
  getDetail: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const f = await ctx.db.family.findFirst({
        where: { id: input.id, deletedAt: null },
        include: {
          members: {
            include: {
              contact: {
                select: {
                  id: true,
                  kind: true,
                  firstName: true,
                  lastName: true,
                  isMinor: true,
                },
              },
            },
          },
          billingContact: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          // ADR 0015: surface the dynamic pipeline stage on the family
          // detail header instead of the legacy `state` enum.
          stage: {
            select: { id: true, name: true, color: true, isClosed: true },
          },
        },
      })
      if (!f) throw new TRPCError({ code: 'NOT_FOUND' })

      const [discrepancies, recentInteractions] = await Promise.all([
        ctx.db.reconciliationDiscrepancy.findMany({
          where: { familyId: f.id, resolvedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            id: true,
            category: true,
            createdAt: true,
            contextHash: true,
          },
        }),
        ctx.db.interaction.findMany({
          where: { familyId: f.id, deletedAt: null },
          orderBy: { occurredAt: 'desc' },
          take: 25,
          select: {
            id: true,
            type: true,
            occurredAt: true,
            summary: true,
          },
        }),
      ])

      return {
        id: f.id,
        name: f.name,
        state: f.state,
        stage: f.stage
          ? {
              id: f.stage.id,
              name: f.stage.name,
              color: f.stage.color,
              isClosed: f.stage.isClosed,
            }
          : null,
        billingParty: f.billingParty,
        churnScore: f.churnScore,
        billingContact: f.billingContact
          ? {
              id: f.billingContact.id,
              name: [f.billingContact.firstName, f.billingContact.lastName]
                .filter(Boolean)
                .join(' '),
              email: f.billingContact.email,
            }
          : null,
        members: f.members.map((m) => ({
          contactId: m.contactId,
          role: m.role,
          name: [m.contact.firstName, m.contact.lastName].filter(Boolean).join(' '),
          isMinor: m.contact.isMinor,
          kind: m.contact.kind,
        })),
        openDiscrepancies: discrepancies.map((d) => ({
          id: d.id,
          category: d.category as string,
          createdAt: d.createdAt,
        })),
        recentInteractions: recentInteractions.map((i) => ({
          id: i.id,
          type: i.type as string,
          occurredAt: i.occurredAt,
          summary: i.summary,
        })),
      }
    }),
})
