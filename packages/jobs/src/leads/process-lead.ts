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
import { createCard, findOrCreateSubject } from '@studymind/core/board'
import {
  asTypedPhoneFallback,
  buildPhoneMatch,
  chooseContactMatch,
  classifyLead,
  composePhoneE164,
  dialCountryFromPhone,
  findDialCountry,
  inferPhoneE164,
  londonWallToUtc,
  normaliseLead,
  planLeadRouting,
  type ClassificationRuleset,
  type LeadClassification,
  type NormalisedLead,
  type RawLeadInput,
} from '@studymind/core/lead'

const ACTOR_ID = 'system:lead-classify'
/** Auto-created lead contacts start `unclassified` — a human classifies them
 *  rather than the system assuming "parent". */
const DEFAULT_LEAD_CONTACT_KIND = 'unclassified' as const

export interface LeadAiEnrichment {
  summary: string
  intent: string
  urgency: 'low' | 'medium' | 'high'
  suggestedCategories: string[]
  suggestedProductTags: string[]
  /** AI-detected requested call time ("YYYY-MM-DDTHH:mm" / "YYYY-MM-DD",
   * Europe/London). Fallback only — the deterministic parser wins. */
  preferredCallTime?: string | null
  /** AI-inferred ISO2 country (from the message, city/university named, phone
   * dial code, email domain). Last-resort fallback only — the form field, IP
   * geo, and the phone's own dial code are tried first. */
  countryCode?: string | null
  confidence: number
}

export interface ProcessLeadDeps {
  /** Best-effort AI enrichment; omitted in tests / when OpenAI is unset. */
  enrich?: (input: {
    normalised: NormalisedLead
    classification: LeadClassification
    brandName: string | null
  }) => Promise<LeadAiEnrichment | null>
  /** Best-effort IP → ISO2 country geolocation (injected at the worker
   * boundary so the pure job stays network-free in tests). Used to compose a
   * dial code for nationally-typed phone numbers when the form has no
   * country field. A failure or null never blocks processing. */
  geoCountry?: (ip: string) => Promise<string | null>
  now?: Date
}

export type LeadAction =
  | 'onboarded'
  | 'reenquiry_card'
  | 'reenquiry_annotated'
  /** Junk with no name/email/phone — auto-dismissed (ADR 0044). */
  | 'discarded'
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

function buildContactNotes(
  n: NormalisedLead,
  c: LeadClassification,
  siteName: string | null,
): string {
  const parts: string[] = []
  // Organise: which site + which form the enquiry came through, so an agent
  // reading the contact knows the source at a glance.
  if (siteName) parts.push(`Site: ${siteName}`)
  if (n.formTitle) parts.push(`Form: ${n.formTitle}`)
  if (c.subject) parts.push(`Subject: ${c.subject}`)
  // A number the strict E.164 rules rejected must never vanish — keep it
  // visible on the contact so the agent can still dial it (live bug).
  if (n.phone && !n.phoneE164) parts.push(`Phone (as typed): ${n.phone}`)
  if (c.categories.length) parts.push(`Interest: ${c.categories.join(', ')}`)
  if (c.productTags.length) parts.push(`Products: ${c.productTags.join(', ')}`)
  if (n.parentName) parts.push(`Parent: ${n.parentName}`)
  if (n.preferredWhen) parts.push(`Preferred time: ${n.preferredWhen} (London)`)
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

/** Seed id of the Free Resources board (created by migration). */
const FREE_RESOURCES_BOARD_ID = 'board_seed_free_resources'

async function firstStageOf(db: PrismaClient, boardId: string): Promise<string | null> {
  const stage =
    (await db.pipelineStage.findFirst({
      where: {
        boardId,
        archivedAt: null,
        name: { equals: 'New leads', mode: 'insensitive' },
      },
      select: { id: true },
    })) ??
    (await db.pipelineStage.findFirst({
      where: { boardId, archivedAt: null, isClosed: false },
      orderBy: { position: 'asc' },
      select: { id: true },
    })) ??
    (await db.pipelineStage.findFirst({
      where: { boardId, archivedAt: null },
      orderBy: { position: 'asc' },
      select: { id: true },
    }))
  return stage?.id ?? null
}

/**
 * Resolve the board + first stage a lead should land on. Precedence:
 *   1. `free_resources` classification ALWAYS wins → the Free Resources board
 *      (operator's explicit rule: timewasters/freebies go there regardless).
 *   2. else the lead SOURCE's configured target board (e.g. the ANZ website's
 *      LeadSource → the ANZ Sales Pipeline board), when it is active + has a
 *      landing stage.
 *   3. else the default Sales Pipeline board.
 * Every step falls back to the next so a lead is never lost.
 */
async function resolveLeadDestination(
  db: PrismaClient,
  kind: LeadClassification['destination'],
  preferredBoardId?: string | null,
): Promise<{ boardId: string; stageId: string } | null> {
  if (kind === 'free_resources') {
    const free = await db.board.findFirst({
      where: { id: FREE_RESOURCES_BOARD_ID, archivedAt: null },
      select: { id: true },
    })
    if (free) {
      const stageId = await firstStageOf(db, free.id)
      if (stageId) return { boardId: free.id, stageId }
    }
    // Fall through to the sales board if Free Resources isn't set up yet.
  } else if (preferredBoardId) {
    // The lead source pinned a board (e.g. ANZ website → ANZ pipeline). Use it
    // only when it's a real active board with a landing stage; otherwise fall
    // through to the default so a misconfigured source never drops leads.
    const preferred = await db.board.findFirst({
      where: { id: preferredBoardId, archivedAt: null },
      select: { id: true },
    })
    if (preferred) {
      const stageId = await firstStageOf(db, preferred.id)
      if (stageId) return { boardId: preferred.id, stageId }
    }
  }

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
  const stageId = await firstStageOf(db, board.id)
  if (!stageId) return null
  return { boardId: board.id, stageId }
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
  //    `now` lets the deterministic parser resolve year-less / weekday call
  //    dates ("Friday 24 Jul", "Monday") to a concrete future date.
  const normalised = normaliseLead(lead.rawPayload as unknown as RawLeadInput, { now })

  // 2. Forced brand + target board from the lead source, then deterministic
  // classification. The source's targetBoardId pins its leads to a board (e.g.
  // the ANZ website → the ANZ Sales Pipeline) unless the lead is free-resources.
  let forcedBrandId: string | null = null
  let siteName: string | null = null
  let sourceTargetBoardId: string | null = null
  if (lead.sourceId) {
    const src = await db.leadSource.findUnique({
      where: { id: lead.sourceId },
      select: { defaultBrandId: true, name: true, targetBoardId: true },
    })
    forcedBrandId = src?.defaultBrandId ?? null
    siteName = src?.name ?? null
    sourceTargetBoardId = src?.targetBoardId ?? null
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

  // 5. Country + phone resolution. The form's country field wins; else
  // geo-locate the captured IP. With a country in hand, a nationally-typed
  // number ("928 812 118", Peru) composes to full E.164 so the contact always
  // gets a dialable number (live bug: it only survived in the notes).
  // Country resolution is a strict cheapest-first waterfall so a country is
  // (almost) always found and a nationally-typed number always composes:
  //   (1) the form's own country field;
  //   (2) IP geolocation of the captured visitor IP (free providers);
  //   (3) the phone's OWN dial code, if it was typed in E.164 ("+51…" → PE) —
  //       free + deterministic;
  //   (4) the AI's inferred country (from the message, city/university named,
  //       email domain) — the expert last resort (§18).
  let dialCountry = findDialCountry(normalised.country)
  let countrySource: 'form' | 'ip_geo' | 'phone_dial' | 'ai' | null = dialCountry
    ? 'form'
    : null
  // The form's own visitor-IP field beats the transport IP: CF7 webhooks are
  // POSTed by the WordPress server, so lead.ip is often the site server, not
  // the enquirer.
  const geoIp = normalised.clientIp ?? lead.ip
  if (!dialCountry && geoIp && deps.geoCountry) {
    try {
      const iso2 = await deps.geoCountry(geoIp)
      dialCountry = findDialCountry(iso2)
      if (dialCountry) countrySource = 'ip_geo'
    } catch (err) {
      logger.warn({ leadId, err: String(err) }, 'lead.process.geo_failed')
    }
  }
  if (!dialCountry) {
    // Never read the country back out of a UK-ASSUMED +44 (a bare 0…/7… national
    // number normalisePhone optimistically mapped to +44): that was a circular
    // GB confirmation that pre-empted the AI fallback and locked foreign leads
    // to +44 whenever no form country was given and IP geo failed. Only trust an
    // explicitly-international number here.
    dialCountry =
      (normalised.phoneAssumedCountry ? null : dialCountryFromPhone(normalised.phoneE164)) ??
      dialCountryFromPhone(normalised.phone)
    if (dialCountry) countrySource = 'phone_dial'
  }
  if (!dialCountry && ai?.countryCode) {
    dialCountry = findDialCountry(ai.countryCode)
    if (dialCountry) countrySource = 'ai'
  }
  if (countrySource) {
    logger.info({ leadId, country: dialCountry?.iso2, countrySource }, 'lead.country_resolved')
  }
  // normalisePhone optimistically maps a bare national number (leading 0 OR a
  // leading-7 UK mobile) to +44. When the resolved country (form → IP → AI) says
  // otherwise, recompose with the real dial code so a French "06…" becomes
  // "+336…" and a US "702…" becomes "+1702…", not "+44…". Only recompose a
  // GUESSED +44 (assumedCountry === 'GB'); an explicitly-typed international
  // number is authoritative and never rewritten.
  let formPhoneE164 = normalised.phoneE164
  if (
    normalised.phoneAssumedCountry === 'GB' &&
    dialCountry &&
    dialCountry.dial !== '44' &&
    normalised.phone
  ) {
    formPhoneE164 = composePhoneE164(dialCountry, normalised.phone) ?? formPhoneE164
  }
  const composedPhone =
    !formPhoneE164 && normalised.phone && dialCountry
      ? composePhoneE164(dialCountry, normalised.phone)
      : null
  // No country at all (no form field, geo failed)? The number may still carry
  // its own dial code typed without the + ("51 928 812 118").
  const inferredPhone =
    !formPhoneE164 && !composedPhone && normalised.phone
      ? inferPhoneE164(normalised.phone)
      : null
  // Last resort: a typed number ALWAYS lands on the contact's phone field —
  // as-typed digits beat a number buried in the notes (it stays visible and
  // manually dialable; an agent can fix the prefix later).
  const fallbackPhone =
    !formPhoneE164 && !composedPhone && !inferredPhone && normalised.phone
      ? asTypedPhoneFallback(normalised.phone)
      : null

  // 6. Match an existing contact (conservative — never auto-merge). Matching
  // is format-insensitive so a re-enquiry never duplicates: email is matched
  // case-insensitively (legacy rows may be mixed-case), and phone is matched
  // on EVERY candidate form plus the last-9-digit suffix — so a number stored
  // as "928812118" on the first enquiry and composed to "+51928812118" on the
  // next still resolves to the same contact.
  const email = normalised.email
  const phoneE164 = formPhoneE164 ?? composedPhone ?? inferredPhone ?? fallbackPhone
  const phoneMatch = buildPhoneMatch([
    formPhoneE164,
    composedPhone,
    inferredPhone,
    fallbackPhone,
  ])
  const phoneWhere =
    phoneMatch.exact.length || phoneMatch.suffix
      ? {
          deletedAt: null,
          OR: [
            ...(phoneMatch.exact.length
              ? [{ phoneE164: { in: phoneMatch.exact } }]
              : []),
            ...(phoneMatch.suffix
              ? [{ phoneE164: { endsWith: phoneMatch.suffix } }]
              : []),
          ],
        }
      : null
  // Candidates are ordered most-recently-active first: when several contacts
  // share the email/phone the router attaches to the head of the list
  // (ADR 0044 auto-resolution) — so the order IS the pick.
  const [byEmail, byPhone] = await Promise.all([
    email
      ? db.contact.findMany({
          where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
          select: { id: true },
          orderBy: { updatedAt: 'desc' },
          take: 5,
        })
      : Promise.resolve([] as { id: string }[]),
    phoneWhere
      ? db.contact.findMany({
          where: phoneWhere,
          select: { id: true },
          orderBy: { updatedAt: 'desc' },
          take: 5,
        })
      : Promise.resolve([] as { id: string }[]),
  ])
  // Name-only submissions (no email, no phone): a UNIQUE exact-name match
  // attaches the enquiry; anything else onboards a fresh contact — we never
  // guess between two same-named people (§41.1).
  const byName =
    !email && !phoneE164 && normalised.firstName
      ? await db.contact.findMany({
          where: {
            deletedAt: null,
            firstName: { equals: normalised.firstName, mode: 'insensitive' },
            ...(normalised.lastName
              ? { lastName: { equals: normalised.lastName, mode: 'insensitive' } }
              : { lastName: null }),
          },
          select: { id: true },
          orderBy: { updatedAt: 'desc' },
          take: 2,
        })
      : ([] as { id: string }[])
  const match = chooseContactMatch({ email, phoneE164, byEmail, byPhone, byName })

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
    hasName: Boolean(normalised.firstName || normalised.lastName),
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
    countryCode: dialCountry?.iso2 ?? null,
    classifiedAt: now,
  }

  // Notes/payloads must reflect the *resolved* phone: "Phone (as typed)"
  // only fires when even the as-typed fallback rejected the value (too few
  // digits to be a number at all).
  const normalisedResolved: NormalisedLead = { ...normalised, phoneE164 }

  // 7. Execute the plan atomically. Nothing parks for a human any more
  // (ADR 0044): a submission with no name, email OR phone is junk we cannot
  // act on — auto-dismissed, kept on the Lead log for the audit trail.
  if (plan.kind === 'discard') {
    await db.$transaction(async (tx) => {
      await tx.lead.update({
        where: { id: lead.id },
        data: { ...baseLeadUpdate, status: 'dismissed' },
      })
      await writeAuditLogEntry(tx, {
        actorId: ACTOR_ID,
        requestId: lead.id,
        action: 'lead.dismissed',
        target: { type: 'Lead', id: lead.id },
        after: { auto: true, reason: plan.reason, score: classification.score },
      })
    })
    return { leadId, action: 'discarded', status: 'dismissed', contactId: null, cardId: null }
  }

  const destination = await resolveLeadDestination(
    db,
    classification.destination,
    sourceTargetBoardId,
  )

  // Card enrichment shared by both create paths: the detected Subject becomes
  // a Subject tag (find-or-create) so the board groups by topic, and a
  // form-picked date/time becomes the card's Scheduled-call chip (London → UTC).
  const cardCtx = { actorId: ACTOR_ID, requestId: lead.id }
  let subjectId: string | undefined
  if (classification.subject) {
    const subj = await findOrCreateSubject(db, { name: classification.subject }, cardCtx)
    subjectId = subj.id
  }
  // The form's date/time field (deterministic) wins; the AI's read of the
  // message/odd fields is the fallback. Shape-validated so a malformed AI
  // string can never set a junk chip.
  const aiPreferredWhen =
    ai?.preferredCallTime && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/u.test(ai.preferredCallTime)
      ? ai.preferredCallTime
      : null
  const preferredWhen = normalised.preferredWhen ?? aiPreferredWhen
  const scheduledCallAt = londonWallToUtc(preferredWhen)

  // Card note preview: put the enquiry itself on the card so the board shows
  // what the lead asked about at a glance. Lead cards previously carried no
  // description, so nothing previewed. Prefer the enquirer's own message; fall
  // back to the detected subject (+ preferred time) when the form had none.
  const cardDescription =
    normalised.message?.trim() ||
    [classification.subject, preferredWhen ? `Preferred call: ${preferredWhen}` : null]
      .filter(Boolean)
      .join(' · ') ||
    undefined

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
        select: {
          firstName: true,
          lastName: true,
          email: true,
          phoneE164: true,
          country: true,
          notes: true,
        },
      })
      if (existingContact) {
        const patch: Prisma.ContactUpdateInput = {}
        if (!existingContact.firstName && normalised.firstName)
          patch.firstName = clamp(normalised.firstName, 120)
        if (!existingContact.lastName && normalised.lastName)
          patch.lastName = clamp(normalised.lastName, 120)
        if (!existingContact.email && normalised.email) patch.email = normalised.email
        if (phoneE164) {
          if (!existingContact.phoneE164) patch.phoneE164 = phoneE164
          // Self-heal: an earlier enquiry stored the digits as typed (no +).
          // Now the country is identified, upgrade to proper E.164 — a repair
          // of malformed data, never an overwrite of a good number (§3).
          else if (!existingContact.phoneE164.startsWith('+') && phoneE164.startsWith('+'))
            patch.phoneE164 = phoneE164
        }
        if (!existingContact.country && (dialCountry?.name ?? normalised.country))
          patch.country = clamp((dialCountry?.name ?? normalised.country)!, 120)
        // Enquiry history: prepend a one-line "latest enquiry" summary so the
        // pinned note always reflects the most recent ask (the full history
        // lives in the Enquiries section / timeline).
        {
          const when = now.toISOString().slice(0, 10)
          const what = classification.subject ?? (classification.categories.join(', ') || 'enquiry')
          const where = siteName ?? normalised.landingDomain ?? normalised.source
          const line = `[${when}] Enquired again: ${what} via ${where}${normalised.formTitle ? ` (${normalised.formTitle})` : ''}`
          patch.notes = clamp(`${line}\n${existingContact.notes ?? ''}`, 4000)
        }
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

      if (subjectId) {
        // The contact's subject tags follow the latest enquiry (additive —
        // we never remove tags an agent may have set; §3 no silent mutation).
        await tx.contactSubject.upsert({
          where: { contactId_subjectId: { contactId, subjectId } },
          create: { contactId, subjectId, createdById: ACTOR_ID },
          update: {},
        })
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
            // The match was a shared email/phone auto-resolved to the most
            // recently active contact (ADR 0044) — visible on the timeline so
            // a wrong pick is spottable and correctable.
            matchAmbiguousResolved: plan.ambiguousResolved,
            matchReason: match.reason,
            createdCard: wantCard,
            categories: classification.categories,
            productTags: classification.productTags,
            score: classification.score,
            subject: classification.subject,
            board: classification.destination,
            site: siteName,
            formTitle: normalised.formTitle,
            preferredWhen,
            message: normalised.message,
            landingUrl: normalised.landingUrl,
            aiSummary: ai?.summary ?? null,
            phoneAsTyped: phoneE164 ? null : normalised.phone,
            ip: lead.ip,
            countryCode: dialCountry?.iso2 ?? null,
          } as Prisma.InputJsonValue,
        },
      })
      if (wantCard && destination) {
        const card = await createCard(
          tx,
          {
            boardId: destination.boardId,
            stageId: destination.stageId,
            contact: { contactId },
            subjectId,
            scheduledCallAt,
            description: cardDescription,
          },
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
        after: {
          contactId,
          createdCard: wantCard,
          withinWindow: !plan.createCard,
          ambiguousResolved: plan.ambiguousResolved,
        },
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
  // No usable person name on the form (or we refused a product-shaped one) —
  // name the contact by their email (else phone) so the record is always
  // identifiable, never after the freebie they downloaded.
  const fallbackName =
    !normalised.firstName && !normalised.lastName ? (email ?? phoneE164 ?? null) : null
  const ctx = { actorId: ACTOR_ID, requestId: lead.id }
  const contactId = createId()
  let cardId: string | null = null

  await db.$transaction(async (tx) => {
    await tx.contact.create({
      data: {
        id: contactId,
        kind: DEFAULT_LEAD_CONTACT_KIND,
        firstName: normalised.firstName
          ? clamp(normalised.firstName, 120)
          : fallbackName
            ? clamp(fallbackName, 120)
            : null,
        lastName: normalised.lastName ? clamp(normalised.lastName, 120) : null,
        email: normalised.email,
        phoneE164,
        country: dialCountry?.name ?? (normalised.country ? clamp(normalised.country, 120) : null),
        notes: buildContactNotes(normalisedResolved, classification, siteName),
        // Organise by site: "Web enquiry · Medic Mind site" so the Contacts
        // list + filters group by where the lead came from.
        referralSource: clamp(siteName ? `Web enquiry · ${siteName}` : 'Web enquiry', 120),
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
    if (subjectId) {
      await tx.contactSubject.create({
        data: { contactId, subjectId, createdById: ACTOR_ID },
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
          subject: classification.subject,
          board: classification.destination,
          site: siteName,
          formTitle: normalised.formTitle,
          preferredWhen,
          message: normalised.message,
          landingUrl: normalised.landingUrl,
          aiSummary: ai?.summary ?? null,
          phoneAsTyped: phoneE164 ? null : normalised.phone,
          ip: lead.ip,
          countryCode: dialCountry?.iso2 ?? null,
        } as Prisma.InputJsonValue,
      },
    })

    if (destination) {
      const card = await createCard(
        tx,
        {
          boardId: destination.boardId,
          stageId: destination.stageId,
          contact: { contactId },
          subjectId,
          scheduledCallAt,
        },
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
