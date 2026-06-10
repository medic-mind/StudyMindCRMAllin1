// Worker boundary for the lead classify + route job (ADR 0023).
//
// The pure orchestration (normalise → classify → match/onboard → route) lives
// in `@studymind/jobs/leads/process-lead`. The AI enrichment glue lives here so
// `packages/jobs` does not import the OpenAI client directly through a cycle —
// it injects an `enrich` callback. AI is best-effort + budget-guarded; the
// deterministic rules are authoritative, so a missing OPENAI_API_KEY (or a
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

const enrichLead: NonNullable<ProcessLeadDeps['enrich']> = async ({
  normalised,
  classification,
  brandName,
}): Promise<LeadAiEnrichment | null> => {
  if (!process.env['OPENAI_API_KEY']) return null
  const prompt = buildLeadClassificationPrompt({
    brandName,
    landingUrl: normalised.landingUrl,
    formTitle: normalised.formTitle,
    categories: classification.categories,
    productTags: classification.productTags,
    message: normalised.message,
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

/** Best-effort IP → ISO2 country (ipwho.is, free, https, no key). Private /
 * local addresses are skipped; any failure returns null and never blocks the
 * lead. 3s timeout so a slow geo provider can't stall the queue. */
async function geoCountry(ip: string): Promise<string | null> {
  if (
    /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|fc|fd)/iu.test(ip) ||
    ip === 'localhost'
  ) {
    return null
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await safeFetch(
      `https://ipwho.is/${encodeURIComponent(ip)}?fields=success,country_code`,
      { signal: ctrl.signal },
    )
    if (!res.ok) return null
    const body = (await res.json()) as { success?: boolean; country_code?: string }
    return body.success && typeof body.country_code === 'string' ? body.country_code : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
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
