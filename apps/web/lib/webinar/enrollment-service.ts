// Enrolment orchestration: detect weekly-class payers on Stripe, organise them
// into the right class (deterministic matcher first, AI advisory only when
// unsure), and expire enrolments when the subscription lapses.
//
// CLAUDE.md §3 — AI suggests, humans confirm: high-confidence rule matches
// auto-activate; everything else (AI suggestions, low confidence) lands as
// `pending_review`. CLAUDE.md §4/§8 — external API is the source of truth; we
// read the live subscription rather than trusting our mirror.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'
import type Stripe from 'stripe'

import {
  buildWebinarClassMatchPrompt,
  runStructured,
  webinarClassMatchSchema,
  WEBINAR_CLASS_MATCH_PROMPT_VERSION,
} from '@studymind/ai'
import { writeAuditLogEntry } from '@studymind/audit'
import {
  AUTO_ENROLL_CONFIDENCE,
  detectWebinarClasses,
  type DetectedClass,
  type WebinarLevel,
} from '@studymind/core/webinar'
import { client as stripeClient } from '@studymind/integration-stripe'

export interface DetectOptions {
  actorId: string | null
  requestId: string
  /** Consult the AI organiser for subscriptions the rules cannot place. */
  useAi?: boolean
  /** Cap on subscriptions scanned per run. */
  limit?: number
}

export interface DetectResult {
  scanned: number
  matched: number
  autoEnrolled: number
  pendingReview: number
  contactsCreated: number
  aiConsulted: number
  errors: string[]
}

/** Index of the active cohort's classes keyed by `${subject}:${level}`. */
async function activeClassIndex(db: PrismaClient): Promise<Map<string, string>> {
  const cohort = await db.webinarCohort.findFirst({
    where: { status: 'active', deletedAt: null },
    orderBy: { startsOn: 'desc' },
  })
  const index = new Map<string, string>()
  if (!cohort) return index
  const classes = await db.webinarClass.findMany({
    where: { cohortId: cohort.id, active: true, deletedAt: null },
    select: { id: true, subject: true, level: true },
  })
  for (const c of classes) index.set(`${c.subject}:${c.level}`, c.id)
  return index
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
      kind: 'parent',
      firstName: firstName || null,
      lastName: rest.length > 0 ? rest.join(' ') : null,
      email,
      createdById: actorId,
      updatedById: actorId,
    },
  })
  return { id, created: true }
}

/** Pull the descriptive text from a subscription for the matcher. */
function subscriptionTexts(sub: Stripe.Subscription): string[] {
  const texts: string[] = []
  for (const item of sub.items.data) {
    const price = item.price
    if (price?.nickname) texts.push(price.nickname)
    const product = price?.product
    if (product && typeof product !== 'string' && 'name' in product && !product.deleted) {
      texts.push(product.name)
    }
  }
  if (sub.description) texts.push(sub.description)
  const customer = sub.customer
  if (customer && typeof customer !== 'string' && !customer.deleted) {
    if (customer.name) texts.push(customer.name)
  }
  return texts
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

/**
 * Scan active Stripe subscriptions, match each to a class in the active cohort,
 * and upsert enrolments. Idempotent on (classId, contactId): re-running updates
 * the existing enrolment rather than duplicating it.
 */
export async function detectEnrollmentsFromStripe(
  db: PrismaClient,
  opts: DetectOptions,
): Promise<DetectResult> {
  const result: DetectResult = {
    scanned: 0,
    matched: 0,
    autoEnrolled: 0,
    pendingReview: 0,
    contactsCreated: 0,
    aiConsulted: 0,
    errors: [],
  }

  const classIndex = await activeClassIndex(db)
  if (classIndex.size === 0) {
    result.errors.push('No active cohort with classes — create one first.')
    return result
  }

  let stripe: Stripe
  try {
    stripe = stripeClient.createClient()
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : 'Stripe is not configured.')
    return result
  }

  const limit = opts.limit ?? 500
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
      let detected: DetectedClass[] = detectWebinarClasses(...texts)

      if (detected.length === 0 && opts.useAi) {
        const ai = await consultAi(texts.join(' '), opts.requestId)
        result.aiConsulted += 1
        if (ai) detected = [ai]
      }
      if (detected.length === 0) continue

      const payer = payerOf(sub)
      const stripeCustomerId = customerIdOf(sub)
      const expiresAt = sub.current_period_end
        ? new Date(sub.current_period_end * 1000)
        : null

      let contactId: string | null = null
      for (const d of detected) {
        const classId = classIndex.get(`${d.subject}:${d.level}`)
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
      result.errors.push(
        `Subscription ${sub.id}: ${err instanceof Error ? err.message : 'failed'}`,
      )
    }
  }

  return result
}

async function consultAi(description: string, requestId: string): Promise<DetectedClass | null> {
  if (!description.trim()) return null
  try {
    const prompt = buildWebinarClassMatchPrompt({ description })
    const out = await runStructured({
      task: 'webinar_class_match',
      promptVersion: WEBINAR_CLASS_MATCH_PROMPT_VERSION,
      schema: webinarClassMatchSchema,
      system: prompt.system,
      user: prompt.user,
      ctx: { requestId, source: 'webinar.detect' },
    })
    if (!out.subject || !out.level) return null
    return {
      subject: out.subject,
      level: out.level as WebinarLevel,
      // AI suggestions never auto-enrol: clamp below the threshold so they land
      // in review regardless of the model's self-reported confidence.
      confidence: Math.min(out.confidence, AUTO_ENROLL_CONFIDENCE - 0.01),
      reason: `AI: ${out.reason}`,
    }
  } catch {
    return null
  }
}

interface UpsertInput {
  classId: string
  contactId: string
  stripeSubscriptionId: string
  stripeCustomerId: string | null
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
    // Refresh the subscription linkage + expiry; do not downgrade a human's
    // decision (active/paused/cancelled stay as set).
    await db.webinarEnrollment.update({
      where: { id: existing.id },
      data: {
        stripeSubscriptionId: input.stripeSubscriptionId,
        stripeCustomerId: input.stripeCustomerId,
        expiresAt: input.expiresAt,
        matchConfidence: input.detected.confidence,
        matchReason: input.detected.reason,
        // An expired enrolment whose subscription is active again is revived.
        ...(existing.status === 'expired' ? { status: 'active', enrolledAt: new Date() } : {}),
        updatedById: input.actorId,
      },
    })
    return existing.status === 'expired' ? 'active' : (existing.status as 'active' | 'pending_review')
  }

  const id = createId()
  await db.webinarEnrollment.create({
    data: {
      id,
      classId: input.classId,
      contactId: input.contactId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripeCustomerId: input.stripeCustomerId,
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

/**
 * Expire active enrolments whose backing subscription is no longer collecting:
 * either we hold a past `expiresAt`, or our StripeSubscription mirror shows a
 * terminal state. Stops the weekly emails (only `active` enrolments are sent).
 */
export async function expireLapsedEnrollments(
  db: PrismaClient,
  now: Date,
  requestId: string,
): Promise<ExpireResult> {
  const active = await db.webinarEnrollment.findMany({
    where: { status: 'active', deletedAt: null },
    select: { id: true, stripeSubscriptionId: true, expiresAt: true, classId: true, contactId: true },
  })

  const terminal = new Set(['canceled', 'unpaid', 'incomplete_expired'])
  let expired = 0
  for (const e of active) {
    let lapsed = false
    if (e.expiresAt && e.expiresAt.getTime() < now.getTime()) lapsed = true
    if (!lapsed && e.stripeSubscriptionId) {
      const mirror = await db.stripeSubscription.findUnique({
        where: { stripeId: e.stripeSubscriptionId },
        select: { state: true },
      })
      if (mirror && terminal.has(mirror.state)) lapsed = true
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
