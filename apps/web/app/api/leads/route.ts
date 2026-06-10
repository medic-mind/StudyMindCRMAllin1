// Universal lead ingestion endpoint (ADR 0023).
//
// POST /api/leads accepts JSON, form-encoded, multipart, and Contact-Form-7
// webhook payloads with ANY field names. It authenticates by a per-website
// LeadSource API key (Authorization: Bearer / X-API-Key / ?key=) or the global
// fallback token, normalises the payload (no hardcoded field ids), persists the
// raw payload to ProviderEvent + a Lead row, and enqueues the classify job. The
// handler stays thin (CLAUDE.md §7): classification + pipeline routing happen
// async in `lead/classify.requested`.

import { withSentry } from '@studymind/core/observability/sentry'
import type { RawLeadInput } from '@studymind/core/lead'

import { db } from '@/lib/db'
import { constantTimeEqual, extractPresentedKey, hashLeadKey } from '@/lib/leads/api-key'
import { ingestLead } from '@/lib/leads/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ResolvedSource {
  sourceId: string | null
  defaultBrandId: string | null
}

function globalToken(): string | null {
  return process.env['LEAD_WEBHOOK_BEARER_TOKEN'] ?? process.env['LEAD_WEBHOOK_TOKEN'] ?? null
}

async function authenticate(req: Request): Promise<ResolvedSource | null> {
  const key = extractPresentedKey(req)
  if (!key) return null

  const master = globalToken()
  if (master && constantTimeEqual(key, master)) {
    return { sourceId: null, defaultBrandId: null }
  }

  const source = await db.leadSource.findUnique({
    where: { keyHash: hashLeadKey(key) },
    select: { id: true, active: true, defaultBrandId: true },
  })
  if (!source || !source.active) return null
  return { sourceId: source.id, defaultBrandId: source.defaultBrandId }
}

async function parseBody(
  req: Request,
): Promise<{ rawBody: string; fields: Record<string, unknown> }> {
  const ct = req.headers.get('content-type') ?? ''
  const fields: Record<string, unknown> = {}

  if (ct.includes('multipart/form-data')) {
    const fd = await req.formData()
    for (const [k, v] of fd.entries()) fields[k] = typeof v === 'string' ? v : '(file)'
    return { rawBody: JSON.stringify(fields), fields }
  }

  const rawBody = await req.text()
  const looksJson = ct.includes('application/json') || rawBody.trim().startsWith('{')
  if (looksJson) {
    try {
      const parsed = JSON.parse(rawBody)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        Object.assign(fields, parsed)
      }
    } catch {
      // fall through to urlencoded
    }
  }
  if (Object.keys(fields).length === 0 && rawBody) {
    for (const [k, v] of new URLSearchParams(rawBody).entries()) fields[k] = v
  }
  return { rawBody, fields }
}

async function handlePost(req: Request): Promise<Response> {
  const source = await authenticate(req)
  if (!source) {
    return new Response('unauthorised', { status: 401 })
  }

  let parsed: { rawBody: string; fields: Record<string, unknown> }
  try {
    parsed = await parseBody(req)
  } catch {
    return new Response('could not parse body', { status: 400 })
  }
  if (Object.keys(parsed.fields).length === 0) {
    return new Response('empty submission', { status: 400 })
  }

  const url = new URL(req.url)
  const meta = {
    source: url.searchParams.get('source') ?? undefined,
    url: url.searchParams.get('url') ?? undefined,
    formTitle: url.searchParams.get('form_title') ?? undefined,
    formId: url.searchParams.get('form_id') ?? undefined,
  }
  // Client IP: first X-Forwarded-For hop (Railway terminates TLS upstream),
  // falling back to X-Real-IP. Used for country (and so dial-code) derivation.
  const fwd = req.headers.get('x-forwarded-for')
  const ip = (fwd ? fwd.split(',')[0]!.trim() : null) || req.headers.get('x-real-ip') || null
  const headers = {
    origin: req.headers.get('origin'),
    referer: req.headers.get('referer'),
    host: req.headers.get('host'),
    ip,
  }

  const rawInput: RawLeadInput = { fields: parsed.fields, meta, headers }

  const result = await ingestLead({
    db,
    rawInput,
    sourceId: source.sourceId,
    actorId: source.sourceId ? `lead_source:${source.sourceId}` : 'system:lead-endpoint',
  })
  if (result.deduped) {
    return Response.json({ ok: true, deduped: true })
  }
  return Response.json({ ok: true, id: result.id, status: 'received' })
}

export const POST = withSentry(handlePost, { provider: 'lead', surface: 'webhook' })
