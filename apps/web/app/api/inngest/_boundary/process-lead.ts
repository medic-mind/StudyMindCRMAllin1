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
