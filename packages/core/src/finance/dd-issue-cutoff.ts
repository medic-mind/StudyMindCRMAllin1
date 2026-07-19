// Direct Debit "issues" go-live cutoff (ADR 0045 amendment). The CRM is new but
// the business is years old, so a bulk GoCardless import (ADR 0038) surfaces
// long-settled historic problems — e.g. 2020-era failed payments — that would
// otherwise flood the home dashboard "Needs attention" queue. Operators only
// want to action issues from go-live (1 Jul 2026) onward.
//
// Pure + deterministic (no I/O): the raw env string is read at the worker /
// router boundary and passed in, so this stays unit-testable. Each detector row
// carries a representative `issueDate` (the underlying financial event date);
// this module decides whether that date clears the cutoff.

/** Default cutoff — go-live. Overridable via `DD_ISSUES_CUTOFF_DATE`. */
export const DEFAULT_DD_ISSUE_CUTOFF = new Date('2026-07-01T00:00:00.000Z')

/**
 * Resolve the cutoff from a raw env value (`DD_ISSUES_CUTOFF_DATE`), falling
 * back to the go-live default when unset or unparseable. Accepts `YYYY-MM-DD`
 * or a full ISO timestamp.
 */
export function resolveDdIssueCutoff(raw?: string | null): Date {
  if (!raw) return DEFAULT_DD_ISSUE_CUTOFF
  const trimmed = raw.trim()
  if (!trimmed) return DEFAULT_DD_ISSUE_CUTOFF
  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? DEFAULT_DD_ISSUE_CUTOFF : parsed
}

/**
 * Should an issue with this representative date be surfaced under the cutoff?
 * A null date (we could not determine when the issue occurred) is shown rather
 * than hidden — the noise we are filtering (old imported payments) always has a
 * date, so "unknown" errs toward visibility.
 */
export function ddIssueMeetsCutoff(issueDate: Date | null | undefined, cutoff: Date): boolean {
  if (issueDate == null) return true
  return issueDate.getTime() >= cutoff.getTime()
}
