// Customer hours-risk derivation (CLAUDE.md §6.4 pattern — pure + reasons).
//
// Tutoring hours expire 12 months after they are booked. A customer who has
// booked a lot of hours but barely used them — especially as that expiry clock
// runs down — is a complaint waiting to happen ("I paid for hours I never got
// to use"). This module turns the booking-derived figures we already mirror
// (CLAUDE.md §15, ADR 0029) into a single, explainable risk assessment so ops
// can reach out *before* hours lapse.
//
// We combine three independent signals and take the strongest:
//   1. Under-use   — a high proportion of booked hours still unused.
//   2. Idle        — meaningful hours remaining but no recent lesson.
//   3. Expiry      — meaningful hours remaining that expire soon.
// Each signal contributes a 0..1 severity; the row's score is the max, and the
// level (`none | low | medium | high`) is bucketed from it. Every contributing
// signal is reported with a human-readable reason so the UI can explain *why*.
//
// Pure and unit-tested. `now` (and the optional config) are injected so tests
// are deterministic — never call `Date.now()` here (CLAUDE.md §30).

export interface HoursRiskInput {
  /** Total hours ever booked (Contact.hoursBooked mirror). */
  hoursBooked: number | null
  /** Hours delivered/used (Contact.hoursDelivered mirror). */
  hoursDelivered: number | null
  /**
   * Hours remaining on the balance, if the booking profile has been synced.
   * When null we fall back to `hoursBooked - hoursDelivered`.
   */
  hoursRemaining: number | null
  /** Most recent delivered lesson (Contact.lastLessonAt). */
  lastLessonAt: Date | null
  /** Earliest unexpired hours bucket expiry (ContactBookingProfile). */
  nextHoursExpiryAt: Date | null
}

export interface HoursRiskConfig {
  /**
   * A customer must hold at least this many remaining hours to be considered
   * at risk at all — tiny balances are not worth chasing and create noise.
   */
  minRemainingHours: number
  /** Under-use: unused proportion at/above which the signal fires. */
  underuseRatioThreshold: number
  /** Idle: no lesson within this many days (with a balance) fires the signal. */
  idleDays: number
  /** Expiry: hours expiring within this many days fires the signal. */
  expirySoonDays: number
}

export const DEFAULT_HOURS_RISK_CONFIG: HoursRiskConfig = {
  minRemainingHours: 5,
  underuseRatioThreshold: 0.6,
  idleDays: 42, // ~6 weeks quiet
  expirySoonDays: 90, // within 3 months of the 12-month expiry
}

export type HoursRiskLevel = 'none' | 'low' | 'medium' | 'high'

export interface HoursRiskReason {
  signal: 'underuse' | 'idle' | 'expiry'
  /** 0..1 — how strong this individual signal is. */
  severity: number
  /** Human-readable, e.g. "82% of 22h unused". */
  label: string
}

export interface HoursRiskResult {
  level: HoursRiskLevel
  /** 0..1 — the strongest contributing signal. */
  score: number
  /** Derived remaining hours used by the assessment. */
  hoursRemaining: number
  /** Whole days until the next hours bucket expires, or null if unknown. */
  daysToExpiry: number | null
  reasons: HoursRiskReason[]
}

const DAY_MS = 24 * 60 * 60 * 1000

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function levelFromScore(score: number): HoursRiskLevel {
  if (score >= 0.75) return 'high'
  if (score >= 0.5) return 'medium'
  if (score > 0) return 'low'
  return 'none'
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / DAY_MS)
}

/**
 * Pure derivation. Given a customer's booking figures and `now`, returns the
 * risk level, score, and the reasons behind it. No I/O.
 */
export function deriveHoursRisk(
  input: HoursRiskInput,
  now: Date,
  config: HoursRiskConfig = DEFAULT_HOURS_RISK_CONFIG,
): HoursRiskResult {
  const booked = input.hoursBooked ?? 0
  const delivered = input.hoursDelivered ?? 0
  const remaining =
    input.hoursRemaining ?? Math.max(0, booked - delivered)

  const daysToExpiry =
    input.nextHoursExpiryAt != null ? daysBetween(now, input.nextHoursExpiryAt) : null

  const empty: HoursRiskResult = {
    level: 'none',
    score: 0,
    hoursRemaining: remaining,
    daysToExpiry,
    reasons: [],
  }

  // Nothing meaningful left to lose → not a risk, regardless of the clock.
  if (remaining < config.minRemainingHours) return empty

  const reasons: HoursRiskReason[] = []

  // 1. Under-use — what fraction of booked hours is still sitting unused. The
  //    higher the fraction (above the threshold), the stronger the signal.
  if (booked > 0) {
    const unusedRatio = clamp01(remaining / booked)
    if (unusedRatio >= config.underuseRatioThreshold) {
      // Scale severity from the threshold (→0) up to fully-unused (→1).
      const span = 1 - config.underuseRatioThreshold
      const severity = span > 0 ? clamp01((unusedRatio - config.underuseRatioThreshold) / span) : 1
      reasons.push({
        signal: 'underuse',
        severity,
        label: `${Math.round(unusedRatio * 100)}% of ${booked}h unused`,
      })
    }
  }

  // 2. Idle — they hold a balance but have gone quiet. Severity grows the
  //    longer the silence runs past the idle threshold (caps at ~2× the window).
  const lessonRef = input.lastLessonAt
  const idleDays = lessonRef != null ? daysBetween(lessonRef, now) : null
  // Never had a lesson but holds hours is the worst kind of idle.
  if (lessonRef == null) {
    reasons.push({
      signal: 'idle',
      severity: 0.7,
      label: `${remaining}h remaining, no lessons taken yet`,
    })
  } else if (idleDays != null && idleDays >= config.idleDays) {
    const over = idleDays - config.idleDays
    const severity = clamp01(0.4 + (over / config.idleDays) * 0.6)
    reasons.push({
      signal: 'idle',
      severity,
      label: `No lesson in ${idleDays} days, ${remaining}h remaining`,
    })
  }

  // 3. Expiry — the 12-month clock. Closer the expiry (within the window), the
  //    stronger; already-expiring/overdue is maximal.
  if (daysToExpiry != null && daysToExpiry <= config.expirySoonDays) {
    const severity =
      daysToExpiry <= 0
        ? 1
        : clamp01(1 - daysToExpiry / config.expirySoonDays)
    reasons.push({
      signal: 'expiry',
      severity: Math.max(0.5, severity),
      label:
        daysToExpiry <= 0
          ? `${remaining}h expiring now`
          : `${remaining}h expire in ${daysToExpiry} days`,
    })
  }

  if (reasons.length === 0) return empty

  // The row's score is its strongest signal; expiry + under-use together (the
  // classic "paid a lot, used little, about to lose it") naturally lands high
  // because each is independently strong.
  const score = reasons.reduce((max, r) => Math.max(max, r.severity), 0)

  // Reasons sorted strongest-first for display.
  reasons.sort((a, b) => b.severity - a.severity)

  return {
    level: levelFromScore(score),
    score,
    hoursRemaining: remaining,
    daysToExpiry,
    reasons,
  }
}
