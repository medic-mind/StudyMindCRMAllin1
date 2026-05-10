// Cron watchdog. CLAUDE.md §17, §25, Slice 14.
//
// Pure detection: given a clock and a "last successful run" reader, returns
// the list of cron functions that have missed their expected interval. The
// boundary that pages on-call is wired in apps/web/app/api/inngest/...

export interface CronExpectation {
  /** Inngest function id, e.g. `finance/reconcile-all-families`. */
  functionId: string
  /** Expected interval between runs, in ms. */
  intervalMs: number
}

export interface CronStatusReader {
  /**
   * Returns the most recent successful CronRun.finishedAt for `functionId`,
   * or null if there is none.
   */
  lastSuccessAt(functionId: string): Promise<Date | null>
}

export type MissSeverity = 'sev2' | 'sev3'

export interface CronMiss {
  functionId: string
  /** Number of complete intervals elapsed since the last success. */
  intervalsMissed: number
  lastSuccessAt: Date | null
  severity: MissSeverity
}

const SLACK_FACTOR = 1.5

/**
 * Returns the list of crons that have missed their expected interval, with
 * a severity:
 *   - sev3: missed once (interval × SLACK_FACTOR exceeded).
 *   - sev2: missed more than once.
 *
 * A cron that has never run (lastSuccessAt === null) is treated as
 * `intervalsMissed = 2` and pages Sev 2 — we should not silently start an
 * environment with broken crons.
 */
export async function detectCronMisses(
  reader: CronStatusReader,
  expectations: CronExpectation[],
  now: Date = new Date(),
): Promise<CronMiss[]> {
  const out: CronMiss[] = []
  for (const exp of expectations) {
    const last = await reader.lastSuccessAt(exp.functionId)
    if (last === null) {
      out.push({
        functionId: exp.functionId,
        intervalsMissed: 2,
        lastSuccessAt: null,
        severity: 'sev2',
      })
      continue
    }
    const elapsed = now.getTime() - last.getTime()
    const allowed = exp.intervalMs * SLACK_FACTOR
    if (elapsed <= allowed) continue
    const missed = Math.floor(elapsed / exp.intervalMs)
    out.push({
      functionId: exp.functionId,
      intervalsMissed: missed,
      lastSuccessAt: last,
      severity: missed > 1 ? 'sev2' : 'sev3',
    })
  }
  return out
}
