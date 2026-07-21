// Enrolment orchestration: detect weekly-class payers on Stripe, organise them
// into the right class in the RIGHT cohort for today's date (so an August
// sign-up joins the upcoming year, not last year), and expire enrolments when
// the subscription lapses.
//
// CLAUDE.md §3 — AI suggests, humans confirm: high-confidence rule matches
// auto-activate; AI suggestions and low confidence land as `pending_review`.
// CLAUDE.md §4 — the external API is the source of truth; the expiry walker
// refetches the live subscription when Stripe is configured.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'
import type Stripe from 'stripe'

import {
  buildWebinarClassMatchPrompt,
  runStructured,
  webinarClassMatchSchema,
  WEBINAR_CLASS_MATCH_PROMPT_VERSION,
  type WebinarCatalogueOption,
} from '@studymind/ai'
import { writeAuditLogEntry } from '@studymind/audit'
import {
  AUTO_ENROLL_CONFIDENCE,
  buildLevelRules,
  buildSubjectRules,
  detectWebinarClassesWithRules,
  type DetectedClass,
  type LevelRule,
  type SubjectRule,
} from '@studymind/core/webinar'
import { client as stripeClient } from '@studymind/integration-stripe'

export interface DetectOptions {
  actorId: string | null
  requestId: string
  /** Consult the AI organiser for subscriptions the rules cannot place. */
  useAi?: boolean
  /** Cap on subscriptions scanned per run. */
  limit?: number
  /** Reference time used to pick the current cohort. Defaults to now. */
  now?: Date
}

export interface DetectResult {
  scanned: number
  matched: number
  autoEnrolled: number
  pendingReview: number
  contactsCreated: number
  aiConsulted: number
  cohort: string | null
  errors: string[]
}

interface ResolvedClassIndex {
  cohortId: string
  cohortName: string
  /** `${subject}:${level}` -> classId. */
  index: Map<string, string>
}

/**
 * Pick the cohort that applies for `now` and index its classes. Preference:
 *   1. a cohort whose [startsOn, endsOn] contains `now` (prefer status=active),
 *   2. else the soonest upcoming cohort (so summer sign-ups join the new year),
 *   3. else the most recently-ended non-archived cohort.
 * This is how the system "figures out what year it is" at enrolment time.
 */
export async function resolveCohortForDate(
  db: PrismaClient,
  now: Date,
): Promise<ResolvedClassIndex | null> {
  const cohorts = await db.webinarCohort.findMany({
    where: { deletedAt: null, status: { in: ['active', 'planning'] } },
    orderBy: { startsOn: 'asc' },
    select: { id: true, name: true, status: true, startsOn: true, endsOn: true },
  })
  if (cohorts.length === 0) return null

  const containing = cohorts
    .filter((c) => c.startsOn.getTime() <= now.getTime() && now.getTime() <= c.endsOn.getTime())
    .sort((a, b) => (a.status === 'active' ? -1 : b.status === 'active' ? 1 : 0))
  const upcoming = cohorts
    .filter((c) => c.startsOn.getTime() > now.getTime())
    .sort((a, b) => a.startsOn.getTime() - b.startsOn.getTime())

  const chosen = containing[0] ?? upcoming[0] ?? cohorts[cohorts.length - 1]
  if (!chosen) return null

  const classes = await db.webinarClass.findMany({
    where: { cohortId: chosen.id, active: true, deletedAt: null },
    select: { id: true, subject: true, level: true },
  })
  const index = new Map<string, string>()
  for (const c of classes) index.set(`${c.subject}:${c.level}`, c.id)
  return { cohortId: chosen.id, cohortName: chosen.name, index }
}

/** Find an existing contact by email, or create one for the Stripe payer. */
async function resolveContact(
  db: PrismaClient,
  payer: { email: string | null; name: string | null },
  actorId: string | null,
): Promise<{ id: string; created: boolean }> {
  const email = payer.email?.trim().toLowerCase() || null
  if (email) {
    const existing = await db.contact.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    })
    if (existing) return { id: existing.id, created: false }
  }
  const [firstName, ...rest] = (payer.name ?? '').trim().split(/\s+/)
  const id = createId()
  await db.contact.create({
    data: {
      id,
      kind: 'unclassified',
      firstName: firstName || null,
      lastName: rest.length > 0 ? rest.join(' ') : null,
      email,
      createdById: actorId,
      updatedById: actorId,
    },
  })
  return { id, created: true }
}

/** Flatten a metadata object into "key value" fragments for the matcher. */
function metadataText(meta: Stripe.Metadata | null | undefined): string[] {
  if (!meta) return []
  return Object.entries(meta).map(([k, v]) => `${k} ${v}`)
}

/** Pull every descriptive fragment from a subscription for the matcher. */
function subscriptionTexts(sub: Stripe.Subscription): string[] {
  const texts: string[] = []
  texts.push(...metadataText(sub.metadata))
  if (sub.description) texts.push(sub.description)
  for (const item of sub.items.data) {
    const price = item.price
    if (price?.nickname) texts.push(price.nickname)
    texts.push(...metadataText(price?.metadata))
    const product = price?.product
    if (product && typeof product !== 'string' && !product.deleted) {
      if ('name' in product && product.name) texts.push(product.name)
      if ('description' in product && product.description) texts.push(product.description)
      texts.push(...metadataText(product.metadata))
    }
  }
  const customer = sub.customer
  if (customer && typeof customer !== 'string' && !customer.deleted && customer.name) {
    texts.push(customer.name)
  }
  return texts
}

/** "month" | "year" | null from the first recurring price. */
function billingIntervalOf(sub: Stripe.Subscription): string | null {
  for (const item of sub.items.data) {
    const interval = item.price?.recurring?.interval
    if (interval) return interval
  }
  return null
}

function payerOf(sub: Stripe.Subscription): { email: string | null; name: string | null } {
  const customer = sub.customer
  if (customer && typeof customer !== 'string' && !customer.deleted) {
    return { email: customer.email ?? null, name: customer.name ?? null }
  }
  return { email: null, name: null }
}

function customerIdOf(sub: Stripe.Subscription): string | null {
  return typeof sub.customer === 'string' ? sub.customer : (sub.customer?.id ?? null)
}

export async function detectEnrollmentsFromStripe(
  db: PrismaClient,
  opts: DetectOptions,
): Promise<DetectResult> {
  const now = opts.now ?? new Date()
  const result: DetectResult = {
    scanned: 0,
    matched: 0,
    autoEnrolled: 0,
    pendingReview: 0,
    contactsCreated: 0,
    aiConsulted: 0,
    cohort: null,
    errors: [],
  }

  const resolved = await resolveCohortForDate(db, now)
  if (!resolved || resolved.index.size === 0) {
    result.errors.push('No cohort with classes applies to today — create/activate one first.')
    return result
  }
  result.cohort = resolved.cohortName

  // Operator catalogues drive both the deterministic matcher and the AI fallback
  // so added subjects/levels (UCAT, GAMSAT, …) are recognised.
  const cat = await loadCatalogues(db)

  let stripe: Stripe
  try {
    stripe = stripeClient.createClient()
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : 'Stripe is not configured.')
    return result
  }

  // Per-run AI cache keyed on the normalised text, so identical product
  // descriptions across many subscriptions cost at most one AI call (CLAUDE.md
  // §32 cost control).
  const aiCache = new Map<string, DetectedClass[]>()

  const limit = opts.limit ?? 1000
  const params: Stripe.SubscriptionListParams = {
    status: 'active',
    limit: 100,
    expand: ['data.customer', 'data.items.data.price.product'],
  }

  for await (const sub of stripe.subscriptions.list(params)) {
    if (result.scanned >= limit) break
    result.scanned += 1
    try {
      const texts = subscriptionTexts(sub)
      let detected: DetectedClass[] = detectWebinarClassesWithRules(
        { subjectRules: cat.subjectRules, levelRules: cat.levelRules },
        texts,
      )

      if (detected.length === 0 && opts.useAi) {
        const key = texts.join(' ').toLowerCase().replace(/\s+/g, ' ').trim()
        if (key) {
          let cached = aiCache.get(key)
          if (!cached) {
            cached = await consultAi(key, cat, opts.requestId)
            aiCache.set(key, cached)
            result.aiConsulted += 1
          }
          detected = cached
        }
      }
      if (detected.length === 0) continue

      const payer = payerOf(sub)
      const stripeCustomerId = customerIdOf(sub)
      const billingInterval = billingIntervalOf(sub)
      const expiresAt = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null

      let contactId: string | null = null
      for (const d of detected) {
        const classId = resolved.index.get(`${d.subject}:${d.level}`)
        if (!classId) continue
        if (!contactId) {
          const c = await resolveContact(db, payer, opts.actorId)
          contactId = c.id
          if (c.created) result.contactsCreated += 1
        }
        const outcome = await upsertEnrollment(db, {
          classId,
          contactId,
          stripeSubscriptionId: sub.id,
          stripeCustomerId,
          billingInterval,
          expiresAt,
          detected: d,
          actorId: opts.actorId,
          requestId: opts.requestId,
        })
        result.matched += 1
        if (outcome === 'active') result.autoEnrolled += 1
        else result.pendingReview += 1
      }
    } catch (err) {
      result.errors.push(`Subscription ${sub.id}: ${err instanceof Error ? err.message : 'failed'}`)
    }
  }

  return result
}

export interface EnrollFromPurchaseInput {
  /** Already-resolved contact (the boundary matches/creates + records first). */
  contactId: string
  /** The product/line-item text from the payment email — drives the match. */
  productText: string
  billingInterval: 'month' | 'year' | 'one_off' | null
  actorId: string | null
  requestId: string
  /** Consult the AI organiser when the deterministic rules find nothing. */
  useAi?: boolean
  now?: Date
}

export interface EnrollFromPurchaseResult {
  matched: number
  autoEnrolled: number
  pendingReview: number
  cohort: string | null
  reason: 'enrolled' | 'no_class_match' | 'no_cohort'
}

/**
 * Enrol a purchaser into their weekly class(es) from an EMAIL-sourced purchase
 * (ADR 0048) — the no-Stripe-API path. Same engine as the Stripe scan: resolve
 * today's cohort, run the deterministic subject/level matcher over the product
 * text (AI only as a fallback, always `pending_review`), and upsert the
 * enrolment (confident rule match auto-activates, everything else waits for a
 * human — CLAUDE.md §3). Expiry is date-based (there is no live subscription to
 * refetch): a monthly plan gets a rolling window that each renewal email
 * refreshes; a yearly plan ~a year; a one-off never auto-expires.
 */
export async function enrollFromPurchase(
  db: PrismaClient,
  input: EnrollFromPurchaseInput,
): Promise<EnrollFromPurchaseResult> {
  const now = input.now ?? new Date()
  const result: EnrollFromPurchaseResult = {
    matched: 0,
    autoEnrolled: 0,
    pendingReview: 0,
    cohort: null,
    reason: 'no_class_match',
  }

  const resolved = await resolveCohortForDate(db, now)
  if (!resolved || resolved.index.size === 0) {
    result.reason = 'no_cohort'
    return result
  }
  result.cohort = resolved.cohortName

  const cat = await loadCatalogues(db)
  let detected: DetectedClass[] = detectWebinarClassesWithRules(
    { subjectRules: cat.subjectRules, levelRules: cat.levelRules },
    [input.productText],
  )
  if (detected.length === 0 && input.useAi) {
    const key = input.productText.toLowerCase().replace(/\s+/g, ' ').trim()
    if (key) detected = await consultAi(key, cat, input.requestId)
  }
  if (detected.length === 0) return result

  const expiresAt = expiryFromInterval(input.billingInterval, now)
  for (const d of detected) {
    const classId = resolved.index.get(`${d.subject}:${d.level}`)
    if (!classId) continue
    const outcome = await upsertEnrollment(db, {
      classId,
      contactId: input.contactId,
      // Email purchases carry no subscription id; expiry is date-based below.
      stripeSubscriptionId: null,
      stripeCustomerId: null,
      billingInterval: input.billingInterval === 'one_off' ? null : input.billingInterval,
      expiresAt,
      detected: d,
      actorId: input.actorId,
      requestId: input.requestId,
    })
    result.matched += 1
    if (outcome === 'active') result.autoEnrolled += 1
    else result.pendingReview += 1
  }
  if (result.matched > 0) result.reason = 'enrolled'
  return result
}

const DAY_MS = 24 * 60 * 60 * 1000
function expiryFromInterval(
  interval: 'month' | 'year' | 'one_off' | null,
  now: Date,
): Date | null {
  if (interval === 'month') return new Date(now.getTime() + 35 * DAY_MS)
  if (interval === 'year') return new Date(now.getTime() + 372 * DAY_MS)
  return null
}

interface Catalogues {
  subjectRules: SubjectRule[]
  levelRules: LevelRule[]
  subjects: WebinarCatalogueOption[]
  levels: WebinarCatalogueOption[]
  subjectHandles: Set<string>
  levelHandles: Set<string>
}

/** Load the active subject + level catalogues and build matcher rules. */
async function loadCatalogues(db: PrismaClient): Promise<Catalogues> {
  const [subjectRows, levelRows] = await Promise.all([
    db.webinarSubjectOption.findMany({
      where: { archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      select: { handle: true, label: true, aliases: true },
    }),
    db.webinarLevelOption.findMany({
      where: { archivedAt: null },
      orderBy: { sortOrder: 'asc' },
      select: { handle: true, label: true, aliases: true },
    }),
  ])
  return {
    subjectRules: buildSubjectRules(subjectRows),
    levelRules: buildLevelRules(levelRows),
    subjects: subjectRows.map((s) => ({ handle: s.handle, label: s.label })),
    levels: levelRows.map((l) => ({ handle: l.handle, label: l.label })),
    subjectHandles: new Set(subjectRows.map((s) => s.handle)),
    levelHandles: new Set(levelRows.map((l) => l.handle)),
  }
}

async function consultAi(
  description: string,
  cat: Catalogues,
  requestId: string,
): Promise<DetectedClass[]> {
  if (!description.trim() || cat.subjects.length === 0) return []
  try {
    const prompt = buildWebinarClassMatchPrompt({
      description,
      subjects: cat.subjects,
      levels: cat.levels,
    })
    const out = await runStructured({
      task: 'webinar_class_match',
      promptVersion: WEBINAR_CLASS_MATCH_PROMPT_VERSION,
      schema: webinarClassMatchSchema,
      system: prompt.system,
      user: prompt.user,
      // Mini tier (cheap) — explicit for clarity.
      model: 'gpt-4o-mini',
      ctx: { requestId, source: 'webinar.detect' },
    })
    return out.matches
      // The model must copy a real handle; drop anything outside the catalogue
      // so it can never invent a subject/level (CLAUDE.md §3).
      .filter((m) => cat.subjectHandles.has(m.subject) && cat.levelHandles.has(m.level))
      .map((m) => ({
        subject: m.subject,
        level: m.level,
        // AI suggestions never auto-enrol: clamp below the threshold so they
        // land in review regardless of the model's self-reported confidence.
        confidence: Math.min(m.confidence, AUTO_ENROLL_CONFIDENCE - 0.01),
        reason: `AI: ${out.reason}`,
      }))
  } catch {
    return []
  }
}

interface UpsertInput {
  classId: string
  contactId: string
  // Null for an email-sourced purchase that carries no subscription id (ADR 0048).
  stripeSubscriptionId: string | null
  stripeCustomerId: string | null
  billingInterval: string | null
  expiresAt: Date | null
  detected: DetectedClass
  actorId: string | null
  requestId: string
}

async function upsertEnrollment(
  db: PrismaClient,
  input: UpsertInput,
): Promise<'active' | 'pending_review'> {
  const isAi = input.detected.reason.startsWith('AI:')
  const autoActive = !isAi && input.detected.confidence >= AUTO_ENROLL_CONFIDENCE
  const status = autoActive ? 'active' : 'pending_review'
  const source = isAi ? 'ai_advisory' : 'auto_rule'

  const existing = await db.webinarEnrollment.findUnique({
    where: { classId_contactId: { classId: input.classId, contactId: input.contactId } },
    select: { id: true, status: true },
  })

  if (existing) {
    // Refresh linkage + expiry (a re-subscribe brings a NEW subscription id and
    // a fresh period end). Revive an expired enrolment; never downgrade a
    // human's active/paused/cancelled decision.
    const revive = existing.status === 'expired' || existing.status === 'cancelled'
    await db.webinarEnrollment.update({
      where: { id: existing.id },
      data: {
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripeCustomerId: input.stripeCustomerId,
        billingInterval: input.billingInterval,
        expiresAt: input.expiresAt,
        matchConfidence: input.detected.confidence,
        matchReason: input.detected.reason,
        ...(revive ? { status: 'active', enrolledAt: new Date(), deletedAt: null } : {}),
        updatedById: input.actorId,
      },
    })
    if (revive) {
      await writeAuditLogEntry(db, {
        actorId: input.actorId,
        action: 'webinar.enrollment_revived',
        target: { type: 'WebinarEnrollment', id: existing.id },
        after: { stripeSubscriptionId: input.stripeSubscriptionId },
        requestId: input.requestId,
      })
      return 'active'
    }
    return existing.status === 'active' ? 'active' : 'pending_review'
  }

  const id = createId()
  await db.webinarEnrollment.create({
    data: {
      id,
      classId: input.classId,
      contactId: input.contactId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripeCustomerId: input.stripeCustomerId,
      billingInterval: input.billingInterval,
      status,
      source,
      matchConfidence: input.detected.confidence,
      matchReason: input.detected.reason,
      expiresAt: input.expiresAt,
      enrolledAt: status === 'active' ? new Date() : null,
      createdById: input.actorId,
      updatedById: input.actorId,
    },
  })
  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'webinar.enrollment_detected',
    target: { type: 'WebinarEnrollment', id },
    after: { classId: input.classId, contactId: input.contactId, status, source },
    requestId: input.requestId,
  })
  return status
}

export interface ExpireResult {
  checked: number
  expired: number
}

const TERMINAL_STATES = new Set(['canceled', 'unpaid', 'incomplete_expired'])

/**
 * Expire active enrolments whose subscription is no longer collecting. The live
 * Stripe subscription is the source of truth (CLAUDE.md §4): when Stripe is
 * configured we refetch each distinct subscription once and lapse on a terminal
 * status or a past period end (which also covers cancel-at-period-end, since
 * access runs to the end of the paid period — a year for yearly plans). Without
 * Stripe we fall back to our StripeSubscription mirror + the stored expiry.
 */
export async function expireLapsedEnrollments(
  db: PrismaClient,
  now: Date,
  requestId: string,
): Promise<ExpireResult> {
  const active = await db.webinarEnrollment.findMany({
    where: { status: 'active', deletedAt: null },
    select: {
      id: true,
      stripeSubscriptionId: true,
      expiresAt: true,
      classId: true,
      contactId: true,
    },
  })

  let stripe: Stripe | null = null
  try {
    stripe = stripeClient.createClient()
  } catch {
    stripe = null
  }
  const liveCache = new Map<string, { status: string; periodEnd: number | null } | null>()

  let expired = 0
  for (const e of active) {
    let lapsed = false

    if (stripe && e.stripeSubscriptionId) {
      let live = liveCache.get(e.stripeSubscriptionId)
      if (live === undefined) {
        live = await fetchLiveSubscription(stripe, e.stripeSubscriptionId)
        liveCache.set(e.stripeSubscriptionId, live)
      }
      if (live) {
        if (TERMINAL_STATES.has(live.status)) lapsed = true
        if (live.periodEnd && live.periodEnd * 1000 < now.getTime()) lapsed = true
      } else {
        // Subscription not found on Stripe (deleted) → access ends.
        lapsed = true
      }
    } else {
      if (e.expiresAt && e.expiresAt.getTime() < now.getTime()) lapsed = true
      if (!lapsed && e.stripeSubscriptionId) {
        const mirror = await db.stripeSubscription.findUnique({
          where: { stripeId: e.stripeSubscriptionId },
          select: { state: true },
        })
        if (mirror && TERMINAL_STATES.has(mirror.state)) lapsed = true
      }
    }

    if (!lapsed) continue
    await db.webinarEnrollment.update({
      where: { id: e.id },
      data: { status: 'expired', updatedById: null },
    })
    await writeAuditLogEntry(db, {
      actorId: null,
      action: 'webinar.enrollment_expired',
      target: { type: 'WebinarEnrollment', id: e.id },
      after: { classId: e.classId, contactId: e.contactId },
      requestId,
    })
    expired += 1
  }
  return { checked: active.length, expired }
}

async function fetchLiveSubscription(
  stripe: Stripe,
  subscriptionId: string,
): Promise<{ status: string; periodEnd: number | null } | null> {
  try {
    const sub = await stripe.subscriptions.retrieve(subscriptionId)
    return { status: sub.status, periodEnd: sub.current_period_end ?? null }
  } catch (err) {
    // 404 → treat as gone; other errors → unknown, leave as-is (return a
    // non-terminal marker so we don't expire on a transient API error).
    const code = (err as { statusCode?: number }).statusCode
    if (code === 404) return null
    return { status: 'active', periodEnd: null }
  }
}
