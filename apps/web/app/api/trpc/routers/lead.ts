// Lead tray + lead-source (API key) management (ADR 0023).
//
// Reads (list / get / stats) are open to every signed-in role — leads are a
// sales surface and the Virtual Assistant reads everything. Lead writes
// (dismiss / reclassify / correct) are Sales Executive+. Source/API-key
// management is Manager+ (it mints a credential, like the Integrations page).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { inngest } from '@studymind/jobs'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'
import { generateLeadKey, hashLeadKey, lastFour } from '@/lib/leads/api-key'
import { ingestLead } from '@/lib/leads/ingest'

const LEAD_WRITE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
])
const SOURCE_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager', 'manager'])

function assertCanWrite(role: UserRole): void {
  if (!LEAD_WRITE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Insufficient role to modify leads' })
  }
}
function assertCanManageSources(role: UserRole): void {
  if (!SOURCE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Manager or above required' })
  }
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 50) || `source-${Date.now()}`
  )
}

const LEAD_INCLUDE = {
  brand: { select: { id: true, name: true, color: true } },
  source_: { select: { id: true, name: true } },
} as const

type LeadRow = {
  id: string
  name: string | null
  email: string | null
  phoneE164: string | null
  status: string
  score: number | null
  categories: string[]
  productTags: string[]
  source: string
  landingDomain: string | null
  landingUrl: string | null
  formTitle: string | null
  classification: unknown
  createdAt: Date
  convertedToContactId: string | null
  brand: { id: string; name: string; color: string | null } | null
  source_: { id: string; name: string } | null
}

/** Read the detected subject + board ('sales' | 'free_resources') out of the
 * stored classification JSON, defensively (older rows may not have them). */
function readClassificationBits(c: unknown): { subject: string | null; board: string | null } {
  if (c && typeof c === 'object') {
    const obj = c as Record<string, unknown>
    return {
      subject: typeof obj['subject'] === 'string' ? (obj['subject'] as string) : null,
      board: typeof obj['destination'] === 'string' ? (obj['destination'] as string) : null,
    }
  }
  return { subject: null, board: null }
}

function toListItem(l: LeadRow) {
  const { subject, board } = readClassificationBits(l.classification)
  return {
    id: l.id,
    name: l.name,
    email: l.email,
    phone: l.phoneE164,
    status: l.status,
    score: l.score,
    categories: l.categories,
    productTags: l.productTags,
    subject,
    board,
    brand: l.brand,
    sourceName: l.source_?.name ?? null,
    sourceLabel: l.source,
    landingDomain: l.landingDomain,
    landingUrl: l.landingUrl,
    formTitle: l.formTitle,
    createdAt: l.createdAt,
    convertedToContactId: l.convertedToContactId,
  }
}

export const leadRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          status: z
            .enum([
              'all',
              'received',
              'classified',
              'needs_triage',
              'onboarded',
              'reenquiry',
              'dismissed',
            ])
            .default('all'),
          brandId: z.string().optional(),
          search: z.string().trim().max(100).optional(),
          cursor: z.string().nullish(),
          limit: z.number().int().min(1).max(100).default(25),
        })
        .default({ status: 'all', limit: 25 }),
    )
    .query(async ({ ctx, input }) => {
      requireUser(ctx)
      const where = {
        deletedAt: null,
        ...(input.status !== 'all' ? { status: input.status } : {}),
        ...(input.brandId ? { brandCompanyId: input.brandId } : {}),
        ...(input.search
          ? {
              OR: [
                { email: { contains: input.search, mode: 'insensitive' as const } },
                { name: { contains: input.search, mode: 'insensitive' as const } },
                { phoneE164: { contains: input.search } },
                { landingDomain: { contains: input.search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      }
      const rows = await ctx.db.lead.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
        include: LEAD_INCLUDE,
      })
      const hasMore = rows.length > input.limit
      const page = hasMore ? rows.slice(0, input.limit) : rows
      return {
        items: page.map((r) => toListItem(r as unknown as LeadRow)),
        nextCursor: hasMore ? page[page.length - 1]!.id : null,
      }
    }),

  stats: protectedProcedure.query(async ({ ctx }) => {
    requireUser(ctx)
    const grouped = await ctx.db.lead.groupBy({
      by: ['status'],
      where: { deletedAt: null },
      _count: { _all: true },
    })
    const byStatus: Record<string, number> = {}
    let total = 0
    for (const g of grouped) {
      byStatus[g.status] = g._count._all
      total += g._count._all
    }
    return { total, byStatus }
  }),

  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    requireUser(ctx)
    const lead = await ctx.db.lead.findFirst({
      where: { id: input.id, deletedAt: null },
      include: {
        ...LEAD_INCLUDE,
        corrections: {
          orderBy: { createdAt: 'desc' },
          take: 20,
          select: {
            id: true,
            field: true,
            fromValue: true,
            toValue: true,
            actorId: true,
            createdAt: true,
          },
        },
      },
    })
    if (!lead) throw new TRPCError({ code: 'NOT_FOUND' })
    return {
      ...toListItem(lead as unknown as LeadRow),
      referrer: lead.referrer,
      utm: lead.utm,
      classification: lead.classification,
      classifiedAt: lead.classifiedAt,
      rawPayload: lead.rawPayload,
      cardId: lead.cardId,
      corrections: lead.corrections,
    }
  }),

  dismiss: auditedProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanWrite(user.role)
    const lead = await ctx.db.lead.findFirst({
      where: { id: input.id, deletedAt: null },
      select: { id: true },
    })
    if (!lead) throw new TRPCError({ code: 'NOT_FOUND' })
    await ctx.db.lead.update({
      where: { id: lead.id },
      data: { status: 'dismissed', updatedById: user.id },
    })
    await ctx.audit({
      action: 'lead.dismissed',
      target: { type: 'Lead', id: lead.id },
      after: { status: 'dismissed' },
    })
    return { id: lead.id }
  }),

  reclassify: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanWrite(user.role)
      const lead = await ctx.db.lead.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, status: true },
      })
      if (!lead) throw new TRPCError({ code: 'NOT_FOUND' })
      // Only re-run for leads that have not been onboarded — re-running an
      // onboarded lead must never create a duplicate contact/card.
      const eligible = ['received', 'classified', 'needs_triage'].includes(lead.status)
      if (eligible) {
        await ctx.db.lead.update({ where: { id: lead.id }, data: { classifiedAt: null } })
        await inngest.send({ name: 'lead/classify.requested', data: { leadId: lead.id } })
      }
      await ctx.audit({
        action: 'lead.classified',
        target: { type: 'Lead', id: lead.id },
        after: { reclassified: eligible },
      })
      return { id: lead.id, reclassified: eligible }
    }),

  correct: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        field: z.enum(['brand', 'categories', 'productTags', 'score']),
        brandId: z.string().nullable().optional(),
        categories: z.string().array().max(20).optional(),
        productTags: z.string().array().max(20).optional(),
        score: z.number().int().min(0).max(100).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanWrite(user.role)
      const lead = await ctx.db.lead.findFirst({
        where: { id: input.id, deletedAt: null },
        select: {
          id: true,
          brandCompanyId: true,
          categories: true,
          productTags: true,
          score: true,
        },
      })
      if (!lead) throw new TRPCError({ code: 'NOT_FOUND' })

      let fromValue: unknown
      let toValue: unknown
      const data: Record<string, unknown> = {}
      if (input.field === 'brand') {
        fromValue = lead.brandCompanyId
        toValue = input.brandId ?? null
        data['brandCompanyId'] = input.brandId ?? null
      } else if (input.field === 'categories') {
        fromValue = lead.categories
        toValue = input.categories ?? []
        data['categories'] = input.categories ?? []
      } else if (input.field === 'productTags') {
        fromValue = lead.productTags
        toValue = input.productTags ?? []
        data['productTags'] = input.productTags ?? []
      } else {
        fromValue = lead.score
        toValue = input.score ?? null
        data['score'] = input.score ?? null
      }

      await ctx.db.$transaction(async (tx) => {
        await tx.lead.update({ where: { id: lead.id }, data })
        await tx.leadClassificationCorrection.create({
          data: {
            id: createId(),
            leadId: lead.id,
            field: input.field,
            fromValue: (fromValue ?? null) as object,
            toValue: (toValue ?? null) as object,
            actorId: user.id,
          },
        })
      })
      await ctx.audit({
        action: 'lead.classification_corrected',
        target: { type: 'Lead', id: lead.id },
        before: { [input.field]: fromValue },
        after: { [input.field]: toValue },
      })
      return { id: lead.id }
    }),

  /**
   * Integrations "Test Lead Generator". Pushes a synthetic Contact-Form-7-shape
   * submission through the exact same ingest path as the public endpoint
   * (normalise → persist → classify), so an admin can prove the pipeline is
   * healthy. Uses a unique email each time so it exercises the onboard flow.
   */
  sendTest: auditedProcedure
    .input(z.object({ sourceId: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManageSources(user.role)
      const stamp = Date.now()
      const rawInput = {
        fields: {
          'your-name': 'Test Enquirer',
          'your-email': `test+${stamp}@studymind-leadtest.co.uk`,
          'your-phone': '+447700900123',
          'your-message':
            'Test lead from the Integrations page — interested in UCAT and Medicine interview preparation.',
        },
        meta: {
          url: 'https://medicmind.co.uk/ucat-course/?utm_source=crm-test',
          source: 'crm:test-lead',
        },
        headers: {},
      }
      const res = await ingestLead({
        db: ctx.db,
        rawInput,
        sourceId: input?.sourceId ?? null,
        actorId: user.id,
      })
      await ctx.audit({
        action: 'admin.integration_tested',
        target: { type: 'Lead', id: res.id ?? 'deduped' },
        after: { provider: 'lead', test: true, deduped: res.deduped },
      })
      return { id: res.id, deduped: res.deduped }
    }),

  sources: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const user = requireUser(ctx)
      assertCanManageSources(user.role)
      const rows = await ctx.db.leadSource.findMany({
        orderBy: [{ archivedAt: 'asc' }, { createdAt: 'desc' }],
        include: { defaultBrand: { select: { id: true, name: true, color: true } } },
      })
      return rows.map((s) => ({
        id: s.id,
        name: s.name,
        slug: s.slug,
        keyLast4: s.keyLast4,
        active: s.active,
        archived: s.archivedAt != null,
        leadCount: s.leadCount,
        lastLeadAt: s.lastLeadAt,
        defaultBrand: s.defaultBrand,
        createdAt: s.createdAt,
      }))
    }),

    create: auditedProcedure
      .input(
        z.object({
          name: z.string().trim().min(1).max(80),
          defaultBrandId: z.string().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanManageSources(user.role)
        const key = generateLeadKey()
        const id = createId()
        let slug = slugify(input.name)
        // Ensure slug uniqueness with a short suffix on collision.
        const clash = await ctx.db.leadSource.findUnique({ where: { slug }, select: { id: true } })
        if (clash) slug = `${slug}-${id.slice(0, 5)}`
        const created = await ctx.db.leadSource.create({
          data: {
            id,
            name: input.name,
            slug,
            keyHash: hashLeadKey(key),
            keyLast4: lastFour(key),
            defaultBrandId: input.defaultBrandId ?? null,
            createdById: user.id,
            updatedById: user.id,
          },
          select: { id: true, keyLast4: true },
        })
        await ctx.audit({
          action: 'lead.source_created',
          target: { type: 'LeadSource', id: created.id },
          after: { name: input.name, slug },
        })
        // The raw key is returned exactly once; we only persist its hash.
        return { id: created.id, key, keyLast4: created.keyLast4 }
      }),

    update: auditedProcedure
      .input(
        z.object({
          id: z.string(),
          name: z.string().trim().min(1).max(80).optional(),
          defaultBrandId: z.string().nullable().optional(),
          active: z.boolean().optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanManageSources(user.role)
        const existing = await ctx.db.leadSource.findUnique({
          where: { id: input.id },
          select: { id: true },
        })
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
        const data: Record<string, unknown> = { updatedById: user.id }
        if (input.name !== undefined) data['name'] = input.name
        if (input.defaultBrandId !== undefined) data['defaultBrandId'] = input.defaultBrandId
        if (input.active !== undefined) data['active'] = input.active
        await ctx.db.leadSource.update({ where: { id: input.id }, data })
        await ctx.audit({
          action: 'lead.source_updated',
          target: { type: 'LeadSource', id: input.id },
          after: data,
        })
        return { id: input.id }
      }),

    rotate: auditedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanManageSources(user.role)
        const existing = await ctx.db.leadSource.findUnique({
          where: { id: input.id },
          select: { id: true },
        })
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
        const key = generateLeadKey()
        await ctx.db.leadSource.update({
          where: { id: input.id },
          data: { keyHash: hashLeadKey(key), keyLast4: lastFour(key), updatedById: user.id },
        })
        await ctx.audit({
          action: 'lead.source_updated',
          target: { type: 'LeadSource', id: input.id },
          after: { rotatedKey: true },
        })
        return { id: input.id, key, keyLast4: lastFour(key) }
      }),

    archive: auditedProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanManageSources(user.role)
        const existing = await ctx.db.leadSource.findUnique({
          where: { id: input.id },
          select: { id: true },
        })
        if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
        await ctx.db.leadSource.update({
          where: { id: input.id },
          data: { active: false, archivedAt: new Date(), updatedById: user.id },
        })
        await ctx.audit({
          action: 'lead.source_archived',
          target: { type: 'LeadSource', id: input.id },
          after: { archived: true },
        })
        return { id: input.id }
      }),
  }),
})
