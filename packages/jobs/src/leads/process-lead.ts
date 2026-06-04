// Lead processor (ADR 0023). The cross-cutting orchestration behind the
// `lead/classify.requested` Inngest job: re-normalise the stored payload,
// classify it (deterministic rules first; optional AI enrichment), match or
// onboard a Contact, dedupe re-enquiries onto that Contact (24h rule), and
// drop a card on the Sales Pipeline. Pure decisions live in @studymind/core/
// lead; this file is the glue + DB writes.
//
// Idempotent: a Lead with `classifiedAt` set is skipped, and the writes commit
// in a single transaction with `classifiedAt`, so an Inngest retry never
// double-onboards.

import { createId } from '@paralleldrive/cuid2'

import type { Prisma, PrismaClient } from '@studymind/db'
import { writeAuditLogEntry } from '@studymind/audit'
import { logger } from '@studymind/core'
import { createCard } from '@studymind/core/board'
import {
  chooseContactMatch,
  classifyLead,
  normaliseLead,
  planLeadRouting,
  type ClassificationRuleset,
  type LeadClassification,
  type NormalisedLead,
  type RawLeadInput,
} from '@studymind/core/lead'

const ACTOR_ID = 'system:lead-classify'
/** Web enquirers are most often parents in an education CRM; agents recategorise. */
const DEFAULT_LEAD_CONTACT_KIND = 'parent' as const

export interface LeadAiEnrichment {
  summary: string
  intent: string
  urgency: 'low' | 'medium' | 'high'
  suggestedCategories: string[]
  suggestedProductTags: string[]
  confidence: number
}

export interface ProcessLeadDeps {
  /** Best-effort AI enrichment; omitted in tests / when OpenAI is unset. */
  enrich?: (input: {
    normalised: NormalisedLead
    classification: LeadClassification
    brandName: string | null
  }) => Promise<LeadAiEnrichment | null>
  now?: Date
}

export type LeadAction =
  | 'onboarded'
  | 'reenquiry_card'
  | 'reenquiry_annotated'
  | 'needs_triage'
  | 'skipped'

export interface ProcessLeadResult {
  leadId: string
  action: LeadAction
  status: string
  contactId: string | null
  cardId: string | null
}

function clamp(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

function buildEnquirySummary(n: NormalisedLead, c: LeadClassification): string {
  const where = n.landingDomain
    ? `${n.landingDomain}${n.landingSlug ? `/${n.landingSlug}` : ''}`
    : (n.formTitle ?? n.source)
  const what = c.categories.length ? ` — ${c.categories.join(', ')}` : ''
  return clamp(`Web enquiry via ${where}${what}`, 280)
}

function buildContactNotes(n: NormalisedLead, c: LeadClassification): string {
  const parts: string[] = []
  if (c.categories.length) parts.push(`Interest: ${c.categories.join(', ')}`)
  if (c.productTags.length) parts.push(`Products: ${c.productTags.join(', ')}`)
  if (n.parentName) parts.push(`Parent: ${n.parentName}`)
  if (n.message) parts.push(`Message: "${n.message}"`)
  return clamp(parts.join('\n'), 2000)
}

async function loadRuleset(db: PrismaClient): Promise<ClassificationRuleset> {
  const [brandRules, urlRules, products] = await Promise.all([
    db.brandDomainRule.findMany({
      where: { active: true },
      select: { id: true, pattern: true, companyId: true, priority: true },
    }),
    db.urlClassificationRule.findMany({
      where: { active: true },
      select: {
        id: true,
        label: true,
        pattern: true,
        matchType: true,
        productTags: true,
        categories: true,
        brandId: true,
        priority: true,
      },
    }),
    db.productCatalogueItem.findMany({
      where: { active: true },
      select: { id: true, handle: true, name: true, category: true, aliases: true, brandId: true },
    }),
  ])
  return { brandRules, urlRules, products }
}

async function resolveLeadDestination(
  db: PrismaClient,
): Promise<{ boardId: string; stageId: string } | null> {
  const board =
    (await db.board.findFirst({
      where: { isDefault: true, archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    })) ??
    (await db.board.findFirst({
      where: { archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    }))
  if (!board) return null

  const stage =
    (await db.pipelineStage.findFirst({
      where: {
        boardId: board.id,
        archivedAt: null,
        name: { equals: 'New leads', mode: 'insensitive' },
      },
      select: { id: true },
    })) ??
    (await db.pipelineStage.findFirst({
      where: { boardId: board.id, archivedAt: null, isClosed: false },
      orderBy: { position: 'asc' },
      select: { id: true },
    })) ??
    (await db.pipelineStage.findFirst({
      where: { boardId: board.id, archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    }))
  if (!stage) return null
  return { boardId: board.id, stageId: stage.id }
}

export async function processLead(
  db: PrismaClient,
  leadId: string,
  deps: ProcessLeadDeps = {},
): Promise<ProcessLeadResult> {
  const now = deps.now ?? new Date()
  const lead = await db.lead.findUnique({ where: { id: leadId } })
  if (!lead) {
    logger.warn({ leadId }, 'lead.process.not_found')
    return { leadId, action: 'skipped', status: 'received', contactId: null, cardId: null }
  }
  if (lead.classifiedAt) {
    // Idempotent: already processed by an earlier (successful) run.
    return {
      leadId,
      action: 'skipped',
      status: lead.status,
      contactId: lead.convertedToContactId ?? null,
      cardId: lead.cardId ?? null,
    }
  }

  // 1. Re-normalise the stored raw payload (deterministic; no extra column).
  const normalised = normaliseLead(lead.rawPayload as unknown as RawLeadInput)

  // 2. Forced brand from the lead source, then deterministic classification.
  let forcedBrandId: string | null = null
  if (lead.sourceId) {
    const src = await db.leadSource.findUnique({
      where: { id: lead.sourceId },
      select: { defaultBrandId: true },
    })
    forcedBrandId = src?.defaultBrandId ?? null
  }
  const ruleset = await loadRuleset(db)
  const classification = classifyLead(normalised, ruleset, { forcedBrandId })

  // 3. Brand name for tagging/audit/AI context.
  let brandName: string | null = null
  if (classification.brandCompanyId) {
    const company = await db.company.findUnique({
      where: { id: classification.brandCompanyId },
      select: { name: true },
    })
    brandName = company?.name ?? null
  }

  // 4. Optional AI enrichment (advisory; never overrides the rules).
  let ai: LeadAiEnrichment | null = null
  if (deps.enrich) {
    try {
      ai = await deps.enrich({ normalised, classification, brandName })
    } catch (err) {
      logger.warn({ leadId, err: String(err) }, 'lead.process.ai_enrich_failed')
    }
  }

  // 5. Match an existing contact (conservative — never auto-merge).
  const email = normalised.email
  const phoneE164 = normalised.phoneE164
  const [byEmail, byPhone] = await Promise.all([
    email
      ? db.contact.findMany({ where: { email, deletedAt: null }, select: { id: true }, take: 5 })
      : Promise.resolve([] as { id: string }[]),
    phoneE164
      ? db.contact.findMany({
          where: { phoneE164, deletedAt: null },
          select: { id: true },
          take: 5,
        })
      : Promise.resolve([] as { id: string }[]),
  ])
  const match = chooseContactMatch({ email, phoneE164, byEmail, byPhone })

  let lastEnquiryAt: Date | null = null
  if (match.contactId) {
    const prev = await db.lead.findFirst({
      where: { convertedToContactId: match.contactId, id: { not: lead.id } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    lastEnquiryAt = prev?.createdAt ?? null
  }

  const plan = planLeadRouting({
    hasContactInfo: Boolean(email || phoneE164),
    match,
    lastEnquiryAt,
    now,
  })

  const classificationBlob = {
    ...classification,
    ai,
  } as unknown as Prisma.InputJsonValue

  const baseLeadUpdate = {
    brandCompanyId: classification.brandCompanyId,
    categories: classification.categories,
    productTags: classification.productTags,
    score: classification.score,
    classification: classificationBlob,
    classifiedAt: now,
  }

  // 6. Execute the plan atomically.
  if (plan.kind === 'needs_triage') {
    await db.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: lead.id },
        data: { ...baseLeadUpdate, status: 'needs_triage' },
      })
      await writeAuditLogEntry(tx, {
        actorId: ACTOR_ID,
        requestId: lead.id,
        action: 'lead.classified',
        target: { type: 'Lead', id: lead.id },
        after: { status: 'needs_triage', reason: plan.reason, score: classification.score },
      })
    })
    return { leadId, action: 'needs_triage', status: 'needs_triage', contactId: null, cardId: null }
  }

  const destination = await resolveLeadDestination(db)

  if (plan.kind === 'reenquiry') {
    const contactId = plan.contactId
    const ctx = { actorId: ACTOR_ID, requestId: lead.id }
    let cardId: string | null = null
    const wantCard = plan.createCard && destination !== null

    await db.$transaction(async (tx) => {
      // Fill in details the existing contact is missing (e.g. a contact
      // auto-created from an Aircall/Google Voice call has a phone but no name
      // or email yet). Only blanks are filled — we never overwrite a value the
      // contact already has (CLAUDE.md §3 no silent mutation).
      const existingContact = await tx.contact.findUnique({
        where: { id: contactId },
        select: { firstName: true, lastName: true, email: true, phoneE164: true },
      })
      if (existingContact) {
        const patch: Prisma.ContactUpdateInput = {}
        if (!existingContact.firstName && normalised.firstName)
          patch.firstName = clamp(normalised.firstName, 120)
        if (!existingContact.lastName && normalised.lastName)
          patch.lastName = clamp(normalised.lastName, 120)
        if (!existingContact.email && normalised.email) patch.email = normalised.email
        if (!existingContact.phoneE164 && normalised.phoneE164)
          patch.phoneE164 = normalised.phoneE164
        if (Object.keys(patch).length > 0) {
          patch.updatedById = ACTOR_ID
          await tx.contact.update({ where: { id: contactId }, data: patch })
          await writeAuditLogEntry(tx, {
            actorId: ACTOR_ID,
            requestId: lead.id,
            action: 'contact.updated',
            target: { type: 'Contact', id: contactId },
            before: existingContact,
            after: { ...patch, viaLead: lead.id },
          })
        }
      }

      await tx.interaction.create({
        data: {
          id: createId(),
          type: 'lead_enquiry',
          contactId,
          occurredAt: now,
          summary: buildEnquirySummary(normalised, classification),
          payload: {
            event: 'lead.reenquiry_recorded',
            leadId: lead.id,
            reenquiry: true,
            createdCard: wantCard,
            categories: classification.categories,
            productTags: classification.productTags,
            score: classification.score,
            landingUrl: normalised.landingUrl,
            aiSummary: ai?.summary ?? null,
          } as Prisma.InputJsonValue,
        },
      })
      if (wantCard && destination) {
        const card = await createCard(
          tx,
          { boardId: destination.boardId, stageId: destination.stageId, contact: { contactId } },
          ctx,
        )
        cardId = card.id
      }
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          ...baseLeadUpdate,
          status: 'reenquiry',
          convertedToContactId: contactId,
          convertedAt: now,
          cardId,
        },
      })
      await writeAuditLogEntry(tx, {
        actorId: ACTOR_ID,
        requestId: lead.id,
        action: 'lead.reenquiry_recorded',
        target: { type: 'Lead', id: lead.id },
        after: { contactId, createdCard: wantCard, withinWindow: !plan.createCard },
      })
    })

    return {
      leadId,
      action: wantCard ? 'reenquiry_card' : 'reenquiry_annotated',
      status: 'reenquiry',
      contactId,
      cardId,
    }
  }

  // plan.kind === 'onboard'
  const ctx = { actorId: ACTOR_ID, requestId: lead.id }
  const contactId = createId()
  let cardId: string | null = null

  await db.$transaction(async (tx) => {
    await tx.contact.create({
      data: {
        id: contactId,
        kind: DEFAULT_LEAD_CONTACT_KIND,
        firstName: normalised.firstName ? clamp(normalised.firstName, 120) : null,
        lastName: normalised.lastName ? clamp(normalised.lastName, 120) : null,
        email: normalised.email,
        phoneE164: normalised.phoneE164,
        notes: buildContactNotes(normalised, classification),
        referralSource: 'Web enquiry',
        isMinor: false,
        createdById: ACTOR_ID,
        updatedById: ACTOR_ID,
      },
    })
    if (classification.brandCompanyId) {
      await tx.contactCompany.create({
        data: {
          contactId,
          companyId: classification.brandCompanyId,
          createdById: ACTOR_ID,
        },
      })
    }
    await writeAuditLogEntry(tx, {
      actorId: ACTOR_ID,
      requestId: lead.id,
      action: 'contact.created',
      target: { type: 'Contact', id: contactId },
      after: { id: contactId, viaLead: lead.id, brandCompanyId: classification.brandCompanyId },
    })

    await tx.interaction.create({
      data: {
        id: createId(),
        type: 'lead_enquiry',
        contactId,
        occurredAt: now,
        summary: buildEnquirySummary(normalised, classification),
        payload: {
          event: 'lead.received',
          leadId: lead.id,
          reenquiry: false,
          categories: classification.categories,
          productTags: classification.productTags,
          score: classification.score,
          landingUrl: normalised.landingUrl,
          aiSummary: ai?.summary ?? null,
        } as Prisma.InputJsonValue,
      },
    })

    if (destination) {
      const card = await createCard(
        tx,
        { boardId: destination.boardId, stageId: destination.stageId, contact: { contactId } },
        ctx,
      )
      cardId = card.id
    } else {
      logger.warn({ leadId }, 'lead.process.no_pipeline_board')
    }

    await tx.lead.update({
      where: { id: lead.id },
      data: {
        ...baseLeadUpdate,
        status: 'onboarded',
        convertedToContactId: contactId,
        convertedAt: now,
        cardId,
      },
    })
    await writeAuditLogEntry(tx, {
      actorId: ACTOR_ID,
      requestId: lead.id,
      action: 'lead.converted',
      target: { type: 'Lead', id: lead.id },
      after: {
        contactId,
        cardId,
        brandCompanyId: classification.brandCompanyId,
        score: classification.score,
      },
    })
  })

  return { leadId, action: 'onboarded', status: 'onboarded', contactId, cardId }
}
