// Worker boundary for the lead classify + route job (ADR 0023).
//
// The pure orchestration (normalise → classify → match/onboard → route) lives
// in `@studymind/jobs/leads/process-lead`. The AI enrichment glue lives here so
// `packages/jobs` does not import the OpenAI client directly through a cycle —
// it injects an `enrich` callback. AI is best-effort + budget-guarded; the
// deterministic rules are authoritative, so an unconfigured AI provider (or a
// failed call) never blocks ingestion.

import {
  buildLeadClassificationPrompt,
  leadClassificationSchema,
  runStructured,
} from '@studymind/ai'
import { inngest } from '@studymind/jobs'
import {
  processLead,
  type LeadAiEnrichment,
  type ProcessLeadDeps,
} from '@studymind/jobs/leads/process-lead'

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import { db } from '@/lib/db'

/** "YYYY-MM-DDTHH:mm, Tuesday" in Europe/London — grounds the AI's relative
 * date resolution ("call me Thursday at 3pm"). */
function nowLondonLabel(): string {
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}, ${get('weekday')}`
}

const enrichLead: NonNullable<ProcessLeadDeps['enrich']> = async ({
  normalised,
  classification,
  brandName,
}): Promise<LeadAiEnrichment | null> => {
  // Any configured provider (Gemini default, OpenAI fallback — ADR 0028).
  const aiConfigured =
    process.env['GEMINI_API_KEY'] || process.env['GOOGLE_API_KEY'] || process.env['OPENAI_API_KEY']
  if (!aiConfigured) return null
  const extraFieldsText = Object.entries(normalised.extraFields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  const prompt = buildLeadClassificationPrompt({
    brandName,
    landingUrl: normalised.landingUrl,
    formTitle: normalised.formTitle,
    categories: classification.categories,
    productTags: classification.productTags,
    message: normalised.message,
    phone: normalised.phoneE164 ?? normalised.phone ?? null,
    extraFieldsText: extraFieldsText || null,
    nowLondon: nowLondonLabel(),
  })
  return runStructured({
    task: 'lead_classification',
    promptVersion: prompt.promptVersion,
    schema: leadClassificationSchema,
    schemaName: 'lead_classification',
    system: prompt.system,
    user: prompt.user,
  })
}

/** Fetch with a hard timeout so a slow geo provider can't stall the queue. */
async function fetchWithTimeout(url: string, ms: number): Promise<Response | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await safeFetch(url, { signal: ctrl.signal })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function geoViaIpwho(ip: string): Promise<string | null> {
  const res = await fetchWithTimeout(
    `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`,
    3000,
  )
  if (!res?.ok) return null
  try {
    const body = (await res.json()) as { success?: boolean; country_code?: string }
    return body.success && typeof body.country_code === 'string' ? body.country_code : null
  } catch {
    return null
  }
}

async function geoViaIpapi(ip: string): Promise<string | null> {
  const res = await fetchWithTimeout(`https://ipapi.co/${encodeURIComponent(ip)}/country/`, 3000)
  if (!res?.ok) return null
  try {
    const text = (await res.text()).trim()
    return /^[A-Z]{2}$/u.test(text) ? text : null
  } catch {
    return null
  }
}

async function geoViaGeojs(ip: string): Promise<string | null> {
  const res = await fetchWithTimeout(
    `https://get.geojs.io/v1/ip/country/${encodeURIComponent(ip)}.json`,
    3000,
  )
  if (!res?.ok) return null
  try {
    const body = (await res.json()) as { country?: string }
    return typeof body.country === 'string' && /^[A-Z]{2}$/u.test(body.country)
      ? body.country
      : null
  } catch {
    return null
  }
}

/** Best-effort IP → ISO2 country. THREE free https providers tried in turn
 * (ipwho.is → ipapi.co → geojs.io) because the free tiers rate-limit and a
 * single provider being down would otherwise lose the country (and a
 * nationally-typed phone can't then compose to E.164). Private / local
 * addresses are skipped; any failure returns null and never blocks the lead.
 * When all three fail, the job falls back to the phone's dial code, then AI. */
async function geoCountry(ip: string): Promise<string | null> {
  if (
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fc|fd)/iu.test(ip) ||
    ip === 'localhost'
  ) {
    return null
  }
  return (
    (await geoViaIpwho(ip)) ?? (await geoViaIpapi(ip)) ?? (await geoViaGeojs(ip))
  )
}

/**
 * Retroactive lead/contact repair (operator-triggered from Settings →
 * Integrations → Lead webhook). Two passes, both blanks-only (§3):
 *
 *  1. COUNTRY: every Lead with no countryCode gets the resolution waterfall —
 *     IP geo (3 providers) → the phone's own dial code. The converted
 *     contact's blank `country` is filled and an as-typed (non-E.164) phone
 *     is upgraded to proper E.164 now the country is known.
 *  2. NAMES: contacts christened after a freebie ("PLAB Questions", "BMAT
 *     Questions") are renamed to their email address so the record is
 *     identifiable as a person, never a product.
 *
 * Batched + self-rescheduling with a 2s pause so the free geo providers are
 * never hammered; idempotent (re-runs converge).
 */
export const leadBackfillCountries = inngest.createFunction(
  {
    id: 'lead/backfill-countries',
    name: 'Lead: backfill countries from IP + repair freebie-named contacts',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { event: 'lead/backfill-countries.requested' },
  async ({ event, step, logger }) => {
    const { cursor } = event.data as { cursor?: string | null }

    const batch = await step.run(`countries-${cursor ?? 'start'}`, async () => {
      const { composePhoneE164, dialCountryFromPhone, findDialCountry } = await import(
        '@studymind/core/lead'
      )
      const leads = await db.lead.findMany({
        where: { countryCode: null, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: 40,
        select: { id: true, ip: true, phoneE164: true, convertedToContactId: true },
      })
      let resolved = 0
      for (const lead of leads) {
        let dial = lead.ip ? findDialCountry(await geoCountry(lead.ip)) : null
        if (!dial) dial = dialCountryFromPhone(lead.phoneE164)
        if (!dial) continue
        resolved += 1
        await db.lead.update({ where: { id: lead.id }, data: { countryCode: dial.iso2 } })
        if (lead.convertedToContactId) {
          const c = await db.contact.findUnique({
            where: { id: lead.convertedToContactId },
            select: { id: true, country: true, phoneE164: true, deletedAt: true },
          })
          if (c && !c.deletedAt) {
            if (!c.country) {
              await db.contact.update({ where: { id: c.id }, data: { country: dial.name } })
            }
            // Upgrade an as-typed phone to E.164 now the country is known —
            // a repair of malformed data, never an overwrite of a good number.
            if (c.phoneE164 && !c.phoneE164.startsWith('+')) {
              const composed = composePhoneE164(dial, c.phoneE164)
              if (composed) {
                try {
                  await db.contact.update({
                    where: { id: c.id },
                    data: { phoneE164: composed },
                  })
                } catch {
                  // Unique collision = this E.164 already exists on another
                  // contact — that's a duplicate for the cleanup page, not
                  // something to overwrite here.
                }
              }
            }
          }
        }
      }
      return { count: leads.length, lastId: leads[leads.length - 1]?.id ?? null, resolved }
    })

    if (batch.count === 40 && batch.lastId) {
      await step.sleep('pace-geo-providers', '2s')
      await step.sendEvent('next-batch', {
        name: 'lead/backfill-countries.requested',
        data: { cursor: batch.lastId },
      })
      return { continued: true, ...batch }
    }

    // Final pass (runs once, on the last batch): repair freebie-named contacts.
    const renamed = await step.run('repair-freebie-names', async () => {
      const { isResourceShapedName } = await import('@studymind/core/lead')
      const candidates = await db.contact.findMany({
        where: {
          deletedAt: null,
          email: { not: null },
          referralSource: { startsWith: 'Web enquiry' },
        },
        take: 10000,
        select: { id: true, firstName: true, lastName: true, email: true },
      })
      let count = 0
      for (const c of candidates) {
        const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
        if (!full || !isResourceShapedName(full)) continue
        await db.contact.update({
          where: { id: c.id },
          data: { firstName: c.email, lastName: null },
        })
        count += 1
      }
      return count
    })

    await step.run('audit-complete', async () => {
      const { writeAuditLogEntry } = await import('@studymind/audit')
      await writeAuditLogEntry(db, {
        actorId: null,
        action: 'lead.maintenance_completed',
        target: { type: 'System', id: 'lead-country-backfill' },
        requestId: `lead-maintenance:${new Date().toISOString().slice(0, 10)}`,
        after: { lastBatch: batch.count, renamedFreebieContacts: renamed },
      })
    })
    logger.info({ renamed, lastBatch: batch.count }, 'lead.maintenance_completed')
    return { continued: false, renamed, ...batch }
  },
)

export const leadClassifyRequested = inngest.createFunction(
  {
    id: 'lead/classify-lead',
    name: 'Lead: classify + route a web enquiry',
    // AI-touching, so capped like the other AI-heavy jobs (CLAUDE.md §17).
    concurrency: { limit: 3 },
    retries: 6,
  },
  { event: 'lead/classify.requested' },
  async ({ event, step, logger }) => {
    const { leadId } = event.data as { leadId: string }
    const result = await step.run('process', () =>
      processLead(db, leadId, { enrich: enrichLead, geoCountry }),
    )
    logger.info(
      { leadId, action: result.action, status: result.status, contactId: result.contactId },
      'lead.processed',
    )
    return result
  },
)

/** Rows per reprocess tick — a backlog drains over a few ticks rather than
 *  one giant run (the classify fan-out is AI-capped at 3 anyway). */
const REPROCESS_BATCH = 200

/**
 * Self-healing sweep (ADR 0044): re-runs the classifier over anything not yet
 * resolved — submissions stuck in `received` (an Inngest hiccup at ingest
 * time) and legacy `needs_triage` rows from before routing became fully
 * automatic. With the automated router nothing re-parks, so this drains the
 * historic tray backlog by itself and keeps the pipeline zero-touch.
 */
export const leadReprocessUnresolved = inngest.createFunction(
  {
    id: 'lead/reprocess-unresolved',
    name: 'Lead: re-run classification over unresolved rows',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/30 * * * *' },
  async ({ step, logger }) => {
    const cutoff = new Date(Date.now() - 15 * 60_000)
    const rows = await step.run('find-unresolved', async () =>
      db.lead.findMany({
        where: {
          deletedAt: null,
          softDeletedAt: null,
          OR: [
            { status: 'needs_triage' },
            // Ingested but never classified — the classify event was lost.
            { status: 'received', classifiedAt: null, createdAt: { lt: cutoff } },
          ],
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: REPROCESS_BATCH,
      }),
    )
    if (rows.length === 0) return { reprocessed: 0 }

    await step.run('clear-classified-at', async () => {
      // processLead's idempotency gate is classifiedAt — clear it so the
      // re-run actually routes (same move as the manual lead.reclassify).
      await db.lead.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { classifiedAt: null },
      })
    })
    await step.run('enqueue', async () => {
      await inngest.send(
        rows.map((r) => ({ name: 'lead/classify.requested' as const, data: { leadId: r.id } })),
      )
    })
    logger.info({ reprocessed: rows.length }, 'lead.reprocess_unresolved')
    return { reprocessed: rows.length }
  },
)
