// Safeguarding SLA escalator. CLAUDE.md §42.2.
//
// Runs every 5 minutes. For every SafeguardingFlag still in
// `concern_logged` (= unacknowledged), it computes time-since-raised
// and compares against the urgency SLA:
//   immediate → 15 min
//   urgent    → 1 h
//   routine   → 4 h
//
// On breach, and only if escalatedAt is null (idempotent), it:
//   - re-pages PagerDuty (Critical for `immediate`, Error for the rest)
//   - reassigns the flag to the current deputy DSL (DslRota.role=deputy
//     overlapping `now`); if no deputy is set, falls back to env
//     `DEPUTY_DSL_USER_ID`.
//   - writes an audit entry `safeguarding.sla_breached`
//   - sets escalatedAt = now and escalatedToUserId = <deputy>.

export type Urgency = 'routine' | 'urgent' | 'immediate'

export const SLA_MS: Record<Urgency, number> = {
  immediate: 15 * 60 * 1000,
  urgent: 60 * 60 * 1000,
  routine: 4 * 60 * 60 * 1000,
}

export function isBreached(
  flag: { urgency: Urgency; createdAt: Date },
  now: Date,
): boolean {
  const elapsed = now.getTime() - flag.createdAt.getTime()
  return elapsed >= SLA_MS[flag.urgency]
}

export function pagerDutySeverityFor(urgency: Urgency): 'critical' | 'error' {
  return urgency === 'immediate' ? 'critical' : 'error'
}

// -----------------------------------------------------------------------------
// Minimal DB shape
// -----------------------------------------------------------------------------

export interface FlagForSla {
  id: string
  contactId: string
  state: string
  urgency: Urgency
  createdAt: Date
  acknowledgedAt: Date | null
  escalatedAt: Date | null
  dslUserId: string | null
}

export interface SafeguardingSlaDb {
  safeguardingFlag: {
    findMany: (args: {
      where: { state: 'concern_logged'; escalatedAt: null }
      take: number
      select: Record<string, true>
    }) => Promise<FlagForSla[]>
    update: (args: {
      where: { id: string }
      data: {
        escalatedAt: Date
        escalatedToUserId: string
        dslUserId: string
        updatedById: string | null
      }
    }) => Promise<{ id: string }>
  }
  dslRota: {
    findFirst: (args: {
      where: { weekStart: { lte: Date }; weekEnd: { gte: Date }; role: 'deputy' }
      select: { userId: true }
    }) => Promise<{ userId: string } | null>
  }
}

export interface PagerDutyTrigger {
  trigger: (input: {
    summary: string
    severity: 'critical' | 'error'
    dedupKey: string
    source?: string
    details?: Record<string, unknown>
  }) => Promise<void>
}

const NOOP_PD: PagerDutyTrigger = { trigger: async () => undefined }

export interface SlaAuditWriter {
  write: (input: {
    actorId: string
    action: string
    targetType: string
    targetId: string
    after: unknown
  }) => Promise<void>
}

const NOOP_AUDIT: SlaAuditWriter = { write: async () => undefined }

export const SLA_BATCH_SIZE = 200

// -----------------------------------------------------------------------------
// Deputy resolution
// -----------------------------------------------------------------------------

export async function resolveDeputyDsl(
  db: SafeguardingSlaDb,
  now: Date,
): Promise<string> {
  const row = await db.dslRota.findFirst({
    where: { weekStart: { lte: now }, weekEnd: { gte: now }, role: 'deputy' },
    select: { userId: true },
  })
  if (row) return row.userId
  const fallback = process.env['DEPUTY_DSL_USER_ID']
  if (!fallback) {
    throw new Error('No deputy DSL: DslRota empty for `deputy` and DEPUTY_DSL_USER_ID unset.')
  }
  return fallback
}

// -----------------------------------------------------------------------------
// Main loop
// -----------------------------------------------------------------------------

export interface EscalateOnceResult {
  scanned: number
  escalated: number
  skipped: number
}

export async function escalateOnce(
  db: SafeguardingSlaDb,
  now: Date,
  pd: PagerDutyTrigger = NOOP_PD,
  audit: SlaAuditWriter = NOOP_AUDIT,
): Promise<EscalateOnceResult> {
  const flags = await db.safeguardingFlag.findMany({
    where: { state: 'concern_logged', escalatedAt: null },
    take: SLA_BATCH_SIZE,
    select: {
      id: true,
      contactId: true,
      state: true,
      urgency: true,
      createdAt: true,
      acknowledgedAt: true,
      escalatedAt: true,
      dslUserId: true,
    },
  })

  let escalated = 0
  let skipped = 0
  let deputyId: string | null = null
  for (const flag of flags) {
    // Defensive: `acknowledgedAt` may be set even if state hasn't transitioned
    // (we accept either as "DSL has noticed").
    if (flag.acknowledgedAt) {
      skipped += 1
      continue
    }
    if (!isBreached(flag, now)) {
      skipped += 1
      continue
    }

    if (deputyId === null) deputyId = await resolveDeputyDsl(db, now)

    await pd.trigger({
      summary: `Safeguarding SLA breached (${flag.urgency}) on flag ${flag.id}`,
      severity: pagerDutySeverityFor(flag.urgency),
      dedupKey: `sg-sla:${flag.id}`,
      source: 'studymind-crm-safeguarding-sla',
      details: {
        flagId: flag.id,
        contactId: flag.contactId,
        urgency: flag.urgency,
        previousDsl: flag.dslUserId,
        escalatedTo: deputyId,
      },
    })

    await db.safeguardingFlag.update({
      where: { id: flag.id },
      data: {
        escalatedAt: now,
        escalatedToUserId: deputyId,
        dslUserId: deputyId,
        updatedById: 'system:safeguarding/sla-escalator',
      },
    })

    await audit.write({
      actorId: 'system:safeguarding/sla-escalator',
      action: 'safeguarding.sla_breached',
      targetType: 'SafeguardingFlag',
      targetId: flag.id,
      after: {
        urgency: flag.urgency,
        previousDsl: flag.dslUserId,
        escalatedTo: deputyId,
      },
    })

    escalated += 1
  }

  return { scanned: flags.length, escalated, skipped }
}

// Inngest registration lives at the worker boundary; this package stays free
// of integration-side deps.
export const SAFEGUARDING_SLA_FUNCTIONS: never[] = []
