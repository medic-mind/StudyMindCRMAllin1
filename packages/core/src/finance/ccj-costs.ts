// County Court Judgment (CCJ) cost estimate for Direct Debit recovery letters
// (ADR 0045 amendment). When a debt reaches the "letter before claim" stage,
// the recovery emails quote what pursuing a claim would add on top of the
// balance — the court issue fee and statutory interest — so the figure the
// customer sees is real, not a guessed round number.
//
// Pure + deterministic (money in integer pence, §19; `now` injected for tests).
// England & Wales only (StudyMind is UK). All amounts are ESTIMATES for the
// letter — the actual claim fee/interest are fixed by the court at issue.
//
// Sources (kept in comments so the figures are auditable and updatable).
// Verified 2026-07 against gov.uk EX50/EX50A + the 13 Jul 2026 fee-change
// notices — the money-claim ISSUE scale below was NOT among the fees raised:
//  - Court issue fees: gov.uk "Court and tribunal fees" (EX50), money claims,
//    Fee 1.1 Sch.1 Civil Proceedings Fees Order 2008. Fee is charged on the
//    claim value PLUS interest at the date of issue (so we scale on
//    outstanding + interest below). https://www.gov.uk/make-court-claim-for-money/court-fees
//  - Interest: s69 County Courts Act 1984 — 8% per annum SIMPLE (rate set by
//    the Judgments Act 1838 s17 / 1993 Order). This is the consumer-debt rate;
//    the Late Payment of Commercial Debts Act (base+8%) is B2B ONLY and does
//    NOT apply. s69 interest is at the court's DISCRETION, so the letters say
//    we "may claim" it, never that it is automatic. Daily = principal x 0.08 /
//    365 (gov.uk method). https://www.gov.uk/make-court-claim-for-money/work-out-interest

/** One band of the civil money-claim issue-fee scale. */
export interface CourtFeeBand {
  /** Upper bound of the band in pence; null = the open-ended top band. */
  uptoMinor: number | null
  /** Flat fee in pence, or null when the band is percentage-based. */
  feeMinor: number | null
  /** Percentage of the claim (e.g. 5 for 5%), or null for a flat band. */
  feePercent: number | null
}

/**
 * England & Wales money-claim ISSUE fee scale (gov.uk EX50). Ascending by
 * claim value. Update here if HMCTS changes the scale — the whole recovery
 * system reads these.
 */
export const COURT_ISSUE_FEE_BANDS: CourtFeeBand[] = [
  { uptoMinor: 30_000, feeMinor: 3_500, feePercent: null }, // up to £300 → £35
  { uptoMinor: 50_000, feeMinor: 5_000, feePercent: null }, // £300.01–£500 → £50
  { uptoMinor: 100_000, feeMinor: 7_000, feePercent: null }, // £500.01–£1,000 → £70
  { uptoMinor: 150_000, feeMinor: 8_000, feePercent: null }, // £1,000.01–£1,500 → £80
  { uptoMinor: 300_000, feeMinor: 11_500, feePercent: null }, // £1,500.01–£3,000 → £115
  { uptoMinor: 500_000, feeMinor: 20_500, feePercent: null }, // £3,000.01–£5,000 → £205
  { uptoMinor: 1_000_000, feeMinor: 45_500, feePercent: null }, // £5,000.01–£10,000 → £455
  { uptoMinor: 20_000_000, feeMinor: null, feePercent: 5 }, // £10,000.01–£200,000 → 5%
  { uptoMinor: null, feeMinor: 1_000_000, feePercent: null }, // over £200,000 → £10,000
]

/** s69 County Courts Act 1984 — 8% per annum simple interest on a debt. */
export const STATUTORY_INTEREST_ANNUAL_PERCENT = 8

/** Days a debtor must be given to respond to a Letter of Claim under the
 *  Pre-Action Protocol for Debt Claims (2017). */
export const DEBT_LETTER_RESPONSE_DAYS = 30

/** StudyMind's own late fee (pence) applied to an overdue Direct Debit — a
 *  policy figure, not a court cost. Overridable via `DD_LATE_FEE_GBP`. */
export const DEFAULT_DD_LATE_FEE_MINOR = 1_200

/** Resolve the late fee (pence) from a raw env value (`DD_LATE_FEE_GBP`, a
 *  pounds amount), falling back to the default. */
export function resolveDdLateFeeMinor(raw?: string | null): number {
  if (!raw) return DEFAULT_DD_LATE_FEE_MINOR
  const pounds = Number.parseFloat(raw.trim())
  if (!Number.isFinite(pounds) || pounds < 0) return DEFAULT_DD_LATE_FEE_MINOR
  return Math.round(pounds * 100)
}

/** The court issue fee (pence) for a claim of the given value (pence). */
export function courtIssueFeeMinor(claimMinor: number): number {
  const claim = Math.max(0, Math.round(claimMinor))
  for (const band of COURT_ISSUE_FEE_BANDS) {
    if (band.uptoMinor === null || claim <= band.uptoMinor) {
      if (band.feePercent != null) return Math.round(claim * (band.feePercent / 100))
      return band.feeMinor ?? 0
    }
  }
  return 0
}

export interface CcjEstimateInput {
  /** Balance still owed, in pence. */
  outstandingMinor: number
  /** StudyMind's own late fee already applied, in pence (config; may be 0). */
  lateFeeMinor?: number
  /** When the debt fell overdue (interest accrues from here). Null → 0 days. */
  overdueSince?: Date | null
  now?: Date
  /** Override the statutory rate for tests. */
  annualInterestPercent?: number
}

export interface CcjEstimate {
  outstandingMinor: number
  lateFeeMinor: number
  /** Estimated court issue fee if a claim is brought. */
  courtFeeMinor: number
  /** Statutory interest accrued to `now`. */
  interestMinor: number
  /** Interest added per day at the statutory rate. */
  dailyInterestMinor: number
  daysOverdue: number
  /** outstanding + lateFee + courtFee + interest — the "if it goes to court" total. */
  totalMinor: number
}

/**
 * Estimate what pursuing the debt through the small-claims / County Court would
 * add: statutory interest (8% p.a. simple, from `overdueSince`) plus the court
 * issue fee for the resulting claim value, on top of the balance and any late
 * fee. The court fee is scaled on (outstanding + interest) — the amount claimed.
 */
export function estimateCcjCosts(input: CcjEstimateInput): CcjEstimate {
  const now = input.now ?? new Date()
  const rate = input.annualInterestPercent ?? STATUTORY_INTEREST_ANNUAL_PERCENT
  const outstanding = Math.max(0, Math.round(input.outstandingMinor))
  const lateFee = Math.max(0, Math.round(input.lateFeeMinor ?? 0))

  const daysOverdue = input.overdueSince
    ? Math.max(0, Math.floor((now.getTime() - input.overdueSince.getTime()) / 86_400_000))
    : 0

  const dailyInterestExact = (outstanding * (rate / 100)) / 365
  const interest = Math.round(dailyInterestExact * daysOverdue)
  const courtFee = courtIssueFeeMinor(outstanding + interest)
  const total = outstanding + lateFee + courtFee + interest

  return {
    outstandingMinor: outstanding,
    lateFeeMinor: lateFee,
    courtFeeMinor: courtFee,
    interestMinor: interest,
    dailyInterestMinor: Math.round(dailyInterestExact),
    daysOverdue,
    totalMinor: total,
  }
}
