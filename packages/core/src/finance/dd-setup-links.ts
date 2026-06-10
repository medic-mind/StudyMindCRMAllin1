// Durable Direct Debit sign-up links (ADR 0038 amendment).
//
// GoCardless redirect flows expire after ~30 minutes, so they must never be
// emailed. Instead the CRM emails a durable token URL it owns; opening it
// mints a fresh redirect flow at click time. This module owns the link
// lifecycle (active → completed | revoked | expired) and the automation
// decisions (when the reminder goes out, when a link expires). The email
// itself is sent at the boundary (apps/web) — core stays I/O-free of
// integrations (CLAUDE.md §5).
//
// Time is injected for determinism (CLAUDE.md §30).

import { randomBytes } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

type DbClient = PrismaClient | Prisma.TransactionClient

/** How long a setup link stays usable. */
export const SETUP_LINK_TTL_DAYS = 14
/** One automated reminder this many days after the initial email. */
export const SETUP_LINK_REMINDER_AFTER_DAYS = 3

const DAY_MS = 24 * 60 * 60 * 1000

export type SetupLinkStatus = 'active' | 'completed' | 'revoked' | 'expired'

/** Unguessable URL token. 24 random bytes → 32-char base64url. */
export function generateSetupLinkToken(): string {
  return randomBytes(24).toString('base64url')
}

export interface CreateSetupLinkInput {
  contactId: string
  familyId: string
  description?: string | null
  /** Address the automation emails go to (usually the contact's email). */
  emailTo?: string | null
  actorId: string
  now?: Date
}

export interface SetupLinkRecord {
  id: string
  token: string
  expiresAt: Date
}

export async function createMandateSetupLink(
  db: DbClient,
  input: CreateSetupLinkInput,
): Promise<SetupLinkRecord> {
  const now = input.now ?? new Date()
  const expiresAt = new Date(now.getTime() + SETUP_LINK_TTL_DAYS * DAY_MS)
  const row = await db.mandateSetupLink.create({
    data: {
      id: createId(),
      token: generateSetupLinkToken(),
      contactId: input.contactId,
      familyId: input.familyId,
      description: input.description ?? null,
      status: 'active',
      expiresAt,
      emailTo: input.emailTo ?? null,
      createdById: input.actorId,
      updatedById: input.actorId,
    },
    select: { id: true, token: true, expiresAt: true },
  })
  return row
}

// -----------------------------------------------------------------------------
// Open path (public route)
// -----------------------------------------------------------------------------

export interface OpenableSetupLink {
  id: string
  contactId: string
  familyId: string
  description: string | null
  createdById: string | null
}

export type ResolveSetupLinkResult =
  | { ok: true; link: OpenableSetupLink }
  | { ok: false; reason: 'not_found' | 'expired' | 'completed' | 'revoked' }

/**
 * Pure decision: can this link be opened right now?
 * Exported separately so the rule is unit-testable without a DB.
 */
export function setupLinkOpenState(
  link: { status: string; expiresAt: Date },
  now: Date,
): 'openable' | 'expired' | 'completed' | 'revoked' {
  if (link.status === 'completed') return 'completed'
  if (link.status === 'revoked') return 'revoked'
  if (link.status === 'expired' || link.expiresAt <= now) return 'expired'
  return 'openable'
}

/**
 * Resolve a token for the public open route. Lazily flips a past-expiry row
 * to `expired` so the workspace list stays truthful even between cron runs.
 */
export async function resolveSetupLinkForOpen(
  db: DbClient,
  token: string,
  now: Date = new Date(),
): Promise<ResolveSetupLinkResult> {
  const link = await db.mandateSetupLink.findUnique({
    where: { token },
    select: {
      id: true,
      contactId: true,
      familyId: true,
      description: true,
      status: true,
      expiresAt: true,
      createdById: true,
    },
  })
  if (!link || link.status === 'expired') {
    return link ? { ok: false, reason: 'expired' } : { ok: false, reason: 'not_found' }
  }
  const state = setupLinkOpenState(link, now)
  if (state === 'openable') {
    return {
      ok: true,
      link: {
        id: link.id,
        contactId: link.contactId,
        familyId: link.familyId,
        description: link.description,
        createdById: link.createdById,
      },
    }
  }
  if (state === 'expired') {
    await db.mandateSetupLink.update({
      where: { id: link.id },
      data: { status: 'expired' },
    })
  }
  return { ok: false, reason: state }
}

export async function recordSetupLinkOpen(
  db: DbClient,
  setupLinkId: string,
  now: Date = new Date(),
): Promise<void> {
  await db.mandateSetupLink.update({
    where: { id: setupLinkId },
    data: { lastOpenedAt: now, openCount: { increment: 1 } },
  })
}

// -----------------------------------------------------------------------------
// Email automation state
// -----------------------------------------------------------------------------

export async function markSetupLinkEmailed(
  db: DbClient,
  setupLinkId: string,
  input: { to: string; kind: 'initial' | 'reminder'; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date()
  await db.mandateSetupLink.update({
    where: { id: setupLinkId },
    data:
      input.kind === 'initial'
        ? { emailTo: input.to, emailedAt: now }
        : { reminderSentAt: now },
  })
}

export interface ReminderCandidate {
  id: string
  token: string
  contactId: string
  description: string | null
  emailTo: string
  expiresAt: Date
}

/**
 * Active links whose initial email went out ≥ REMINDER_AFTER days ago, with
 * no reminder yet and time still left on the clock. One reminder per link —
 * we nudge once, we never nag (CLAUDE.md §4).
 */
export async function listSetupLinkReminderCandidates(
  db: DbClient,
  now: Date = new Date(),
): Promise<ReminderCandidate[]> {
  const cutoff = new Date(now.getTime() - SETUP_LINK_REMINDER_AFTER_DAYS * DAY_MS)
  const rows = await db.mandateSetupLink.findMany({
    where: {
      status: 'active',
      deletedAt: null,
      emailedAt: { not: null, lte: cutoff },
      reminderSentAt: null,
      emailTo: { not: null },
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      token: true,
      contactId: true,
      description: true,
      emailTo: true,
      expiresAt: true,
    },
    take: 200,
  })
  return rows.filter((r): r is typeof r & { emailTo: string } => r.emailTo !== null)
}

/** Flip every past-expiry active link to `expired`. Returns the count. */
export async function expireStaleSetupLinks(
  db: DbClient,
  now: Date = new Date(),
): Promise<number> {
  const res = await db.mandateSetupLink.updateMany({
    where: { status: 'active', deletedAt: null, expiresAt: { lte: now } },
    data: { status: 'expired' },
  })
  return res.count
}

// -----------------------------------------------------------------------------
// Terminal transitions
// -----------------------------------------------------------------------------

/**
 * Mark a link completed once its redirect flow produced a mandate.
 * Idempotent — a second completion (parent refreshes the page) is a no-op.
 */
export async function completeSetupLink(
  db: DbClient,
  input: { setupLinkId: string; gcMandateId: string; now?: Date },
): Promise<void> {
  await db.mandateSetupLink.updateMany({
    where: { id: input.setupLinkId, status: { in: ['active', 'expired'] } },
    data: {
      status: 'completed',
      completedAt: input.now ?? new Date(),
      gcMandateId: input.gcMandateId,
    },
  })
}

export type RevokeSetupLinkResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_active' }

export async function revokeSetupLink(
  db: DbClient,
  input: { setupLinkId: string; actorId: string },
): Promise<RevokeSetupLinkResult> {
  const link = await db.mandateSetupLink.findUnique({
    where: { id: input.setupLinkId },
    select: { id: true, status: true },
  })
  if (!link) return { ok: false, reason: 'not_found' }
  if (link.status !== 'active') return { ok: false, reason: 'not_active' }
  await db.mandateSetupLink.update({
    where: { id: link.id },
    data: { status: 'revoked', updatedById: input.actorId },
  })
  return { ok: true }
}
