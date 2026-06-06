// Aircall Inngest functions.
// CLAUDE.md §7.1 (handler stays thin), §10 (Aircall rules: refetch, AI Assist
// vs fallback, recording retention, multi-Contact phone match), §17
// (concurrency, granular step.run, idempotency).

import { createId } from '@paralleldrive/cuid2'

import {
  buildCallOutcomePrompt,
  callOutcomeSchema,
  CALL_OUTCOME_PROMPT_VERSION,
  runStructured,
  transcribeAudio,
} from '@studymind/ai'
import { writeAuditLogEntry } from '@studymind/audit'
import {
  resolveOrCreateContactForCall,
  splitDisplayName,
} from '@studymind/core/contact/from-call'
import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient, type AircallCallResource } from './client'
import { getRecordingBuffer, putRecording } from './s3'
import {
  isAircallEventName,
  mapAircallEventToInteraction,
  type AircallEventName,
  type InteractionEventName,
} from './types'

interface EventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

interface CallContext {
  /** Resolved Family id when phone number matches one or more Contacts. */
  familyId: string | null
  /** Resolved primary Contact id, or null when match was ambiguous (multiple). */
  contactId: string | null
  /** True when multiple Contacts share the number — call attaches to Family
   *  and an agent must triage the assignment. CLAUDE.md §10. */
  triageRequired: boolean
}

// -----------------------------------------------------------------------------
// 1. aircall/event.received — main webhook fan-out.
// -----------------------------------------------------------------------------

export const aircallEventReceived = inngest.createFunction(
  {
    id: 'aircall/event.received',
    name: 'Process Aircall webhook event',
    concurrency: { limit: 5 },
    retries: 6,
  },
  { event: 'aircall/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as EventReceivedData
    const { eventId, providerEventRowId, type } = data

    if (!isAircallEventName(type)) {
      logger.info({ eventId, type }, 'aircall event type not handled — skipping')
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'type_not_handled' }
    }

    const interactionType = mapAircallEventToInteraction(type)
    if (!interactionType) {
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'no_interaction_mapping' }
    }

    // Load the stored ProviderEvent payload for the call id and timestamp.
    const providerEvent = await step.run('load-event', async () => {
      const row = await db.providerEvent.findUniqueOrThrow({
        where: { id: providerEventRowId },
        select: { raw: true },
      })
      return row
    })
    const raw = providerEvent.raw as {
      timestamp: string
      data: { id?: number; call_id?: number; content?: string; language?: string }
    }
    const occurredAt = new Date(raw.timestamp)
    const aircallCallId = raw.data.id ?? raw.data.call_id
    if (!aircallCallId) {
      logger.warn({ eventId, type }, 'aircall event missing call id — skipping')
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'missing_call_id' }
    }

    // For transcription.created, the work is to merge the transcript into the
    // earlier call.* Interaction. Idempotent on aircallCallId.
    if (type === 'transcription.created') {
      await step.run('attach-transcript', async () => {
        await attachTranscriptToCall({
          aircallCallId,
          transcriptText: raw.data.content ?? '',
          language: raw.data.language ?? null,
        })
      })
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { ok: true, kind: 'transcript_attached' }
    }

    // Otherwise: refetch the canonical call. CLAUDE.md §10 — webhook is a
    // notification.
    const call = await step.run('refetch-call', async () => {
      const client = createClient()
      return client.getCall(aircallCallId)
    })

    // Match to Contact / Family by E.164 — creating a lightweight Contact when
    // the number is unknown so the call is never orphaned (CLAUDE.md §10).
    const ctx = await step.run('match-contact', async () => {
      return matchCallToContact(call, eventId)
    })

    // Persist Interaction. Idempotent on (aircallCallId, type).
    const interaction = await step.run('upsert-interaction', async () => {
      return upsertCallInteraction({
        type: interactionType,
        aircallCallId,
        eventId,
        eventName: type,
        occurredAt,
        call,
        ctx,
      })
    })

    // Audit any write that touched a Family or Contact.
    if (ctx.familyId || ctx.contactId) {
      await step.run('audit', async () => {
        await writeAuditLogEntry(db, {
          actorId: null,
          action: `aircall.${type}`,
          target: ctx.familyId
            ? { type: 'Family', id: ctx.familyId }
            : { type: 'Contact', id: ctx.contactId as string },
          requestId: eventId,
          after: {
            aircallCallId,
            interactionId: interaction.id,
            eventName: type,
            triageRequired: ctx.triageRequired,
          },
        })
      })
    }

    // On call.ended without a transcript already in payload, kick off the
    // Whisper fallback. CLAUDE.md §10.
    if (type === 'call.ended' && !call.transcription && call.recording) {
      await step.run('enqueue-fallback-transcribe', async () => {
        await inngest.send({
          name: 'aircall/transcribe-fallback',
          data: { aircallCallId, recordingUrl: call.recording, eventId },
        })
      })
    }

    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    return { ok: true, kind: 'interaction_persisted', interactionId: interaction.id }
  },
)

// -----------------------------------------------------------------------------
// 2. aircall/transcribe-fallback — Whisper + outcome classifier when AI Assist
//    is not on the line. CLAUDE.md §10, §18.
// -----------------------------------------------------------------------------

interface TranscribeFallbackData {
  aircallCallId: number
  recordingUrl: string | null
  eventId: string
}

export const aircallTranscribeFallback = inngest.createFunction(
  {
    id: 'aircall/transcribe-fallback',
    name: 'Aircall: Whisper transcribe + outcome classify (no AI Assist)',
    concurrency: { limit: 3 },
    retries: 4,
  },
  { event: 'aircall/transcribe-fallback' },
  async ({ event, step, logger }) => {
    const data = event.data as TranscribeFallbackData
    const { aircallCallId, recordingUrl } = data
    if (!recordingUrl) {
      return { skipped: true, reason: 'no_recording_url' }
    }

    // Step 1: download from Aircall and persist to S3 before Aircall's
    // retention window expires (CLAUDE.md §10). The S3 key crosses the step
    // boundary; the recording itself does not (Buffers do not survive
    // Inngest step JSON-serialisation).
    const { s3Key, contentType } = await step.run('persist-to-s3', async () => {
      const res = await safeFetch(recordingUrl)
      if (!res.ok) {
        throw new Error(`recording download failed: ${res.status}`)
      }
      const ct = res.headers.get('content-type') ?? 'audio/mpeg'
      const buf = Buffer.from(await res.arrayBuffer())
      const put = await putRecording({
        callId: aircallCallId,
        body: buf,
        contentType: ct,
      })
      return { s3Key: put.s3Key, contentType: ct }
    })

    // Step 2: read the recording back from S3 and send to Whisper.
    const transcript = await step.run('transcribe', async () => {
      const buf = await getRecordingBuffer(s3Key)
      const ext = contentType.includes('wav') ? 'wav' : 'mp3'
      const result = await transcribeAudio({
        audio: buf,
        filename: `${aircallCallId}.${ext}`,
        ctx: { aircallCallId, s3Key },
      })
      return result.text
    })

    const outcome = await step.run('classify-outcome', async () => {
      const prompt = buildCallOutcomePrompt({ transcript })
      return runStructured({
        task: 'call_outcome_classification',
        promptVersion: prompt.promptVersion,
        schema: callOutcomeSchema,
        schemaName: 'call_outcome',
        system: prompt.system,
        user: prompt.user,
        ctx: { aircallCallId, promptVersion: CALL_OUTCOME_PROMPT_VERSION },
      })
    })

    await step.run('persist-transcript', async () => {
      await attachTranscriptToCall({
        aircallCallId,
        transcriptText: transcript,
        language: null,
        outcome,
      })
    })

    logger.info(
      { aircallCallId, outcome: outcome.outcome, confidence: outcome.confidence },
      'aircall.transcribe_fallback.completed',
    )

    return { ok: true, outcome: outcome.outcome }
  },
)

// -----------------------------------------------------------------------------
// 3. aircall/recover-disabled-webhook — recurring hourly. CLAUDE.md §17.1.
//    Aircall disables a webhook after 10 consecutive failures. We re-enable it
//    and audit every flip.
// -----------------------------------------------------------------------------

export const aircallRecoverDisabledWebhook = inngest.createFunction(
  {
    id: 'aircall/recover-disabled-webhook',
    name: 'Aircall: re-enable any webhook disabled by failures',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 * * * *' },
  async ({ step, logger }) => {
    const webhooks = await step.run('list-webhooks', async () => {
      const client = createClient()
      return client.listWebhooks()
    })

    let reenabled = 0
    for (const wh of webhooks) {
      if (wh.disabled !== true && wh.active !== false) continue
      const did = await step.run(`enable-${wh.webhook_id}`, async () => {
        const client = createClient()
        const updated = await client.enableWebhook(wh.webhook_id)
        await writeAuditLogEntry(db, {
          actorId: null,
          action: 'aircall.webhook_reenabled',
          target: { type: 'AircallWebhook', id: wh.webhook_id },
          requestId: `aircall-webhook-recover:${wh.webhook_id}:${new Date().toISOString().slice(0, 10)}`,
          before: { disabled: wh.disabled, active: wh.active },
          after: { disabled: updated.disabled, active: updated.active },
        })
        return true
      })
      if (did) reenabled += 1
    }

    logger.info({ scanned: webhooks.length, reenabled }, 'aircall.webhook_recover.completed')
    return { scanned: webhooks.length, reenabled }
  },
)

// -----------------------------------------------------------------------------
// Helpers — kept module-local so the steps can stay short and readable.
// -----------------------------------------------------------------------------

async function matchCallToContact(
  call: AircallCallResource,
  eventId: string,
): Promise<CallContext> {
  const phone = extractCounterpartyPhone(call)
  if (!phone) return { familyId: null, contactId: null, triageRequired: false }

  // Match by E.164, creating a Contact when the number is unknown so the call
  // is logged against a real record (CLAUDE.md §10). Shared lines return
  // triageRequired and are never auto-merged (§41.1). The caller's name + email
  // (when Aircall has them) are saved to the contact. Idempotent across the
  // several call.* events for one call: the first creates, the rest match.
  const name = extractCounterpartyName(call)
  const result = await resolveOrCreateContactForCall(
    db,
    {
      phoneE164: phone,
      firstName: name?.firstName ?? null,
      lastName: name?.lastName ?? null,
      email: extractCounterpartyEmail(call),
    },
    { referralSource: 'Aircall', actorId: null, requestId: eventId },
  )
  return {
    familyId: result.familyId,
    contactId: result.contactId,
    triageRequired: result.triageRequired,
  }
}

/** Caller name from the Aircall-attached contact, when present. */
function extractCounterpartyName(
  call: AircallCallResource,
): { firstName: string | null; lastName: string | null } | null {
  const c = call.contact
  if (!c) return null
  const first = c.first_name?.trim()
  const last = c.last_name?.trim()
  if (first || last) {
    return { firstName: first || null, lastName: last || null }
  }
  const full = c.full_name?.trim()
  if (full) {
    const split = splitDisplayName(full)
    return { firstName: split.firstName || null, lastName: split.lastName }
  }
  return null
}

function extractCounterpartyEmail(call: AircallCallResource): string | null {
  const email = call.contact?.emails?.find((e) => e.value)?.value
  return email?.trim() || null
}

function extractCounterpartyPhone(call: AircallCallResource): string | null {
  // raw_digits is the counterparty number. Aircall normalises with a leading
  // `+` for E.164.
  const raw = call.raw_digits?.trim()
  if (raw && raw.startsWith('+')) return raw
  // Fallback to the Aircall-attached contact phones (first non-empty entry).
  const fromContact = call.contact?.phone_numbers?.find((p) => p.value)?.value
  if (fromContact && fromContact.startsWith('+')) return fromContact
  return null
}

interface UpsertCallInteractionInput {
  type: InteractionEventName
  aircallCallId: number
  eventId: string
  eventName: AircallEventName
  occurredAt: Date
  call: AircallCallResource
  ctx: CallContext
}

async function upsertCallInteraction(
  input: UpsertCallInteractionInput,
): Promise<{ id: string }> {
  // Idempotent on (aircallCallId, mapped Interaction type).
  const existing = await db.interaction.findFirst({
    where: {
      type: 'call',
      payload: {
        path: ['aircallCallId'],
        equals: input.aircallCallId,
      },
      AND: [
        {
          payload: {
            path: ['interactionType'],
            equals: input.type,
          },
        },
      ],
    },
    select: { id: true },
  })
  if (existing) return existing

  const created = await db.interaction.create({
    data: {
      id: createId(),
      // Prisma enum still uses the legacy `call` value; the registered
      // event name lives in payload.interactionType (CLAUDE.md §45).
      type: 'call',
      contactId: input.ctx.contactId,
      familyId: input.ctx.familyId,
      occurredAt: input.occurredAt,
      summary: buildCallSummary(input.eventName, input.call),
      payload: {
        interactionType: input.type,
        aircallEvent: input.eventName,
        aircallCallId: input.aircallCallId,
        aircallEventId: input.eventId,
        direction: input.call.direction,
        durationSec: input.call.duration,
        recordingUrl: input.call.recording,
        voicemailUrl: input.call.voicemail,
        rawDigits: input.call.raw_digits,
        triageRequired: input.ctx.triageRequired,
        transcriptText: input.call.transcription?.content ?? null,
      },
    },
    select: { id: true },
  })
  return created
}

function buildCallSummary(name: AircallEventName, call: AircallCallResource): string {
  const direction = call.direction === 'inbound' ? 'Inbound' : 'Outbound'
  switch (name) {
    case 'call.created':
    case 'call.ringing_on_agent':
      return `${direction} call started`
    case 'call.answered':
      return `${direction} call answered`
    case 'call.hungup':
    case 'call.ended':
      return `${direction} call ended`
    case 'call.voicemail_left':
      return `${direction} call: voicemail left`
    case 'call.tagged':
      return `${direction} call tagged`
    case 'call.commented':
      return `${direction} call commented`
    case 'transcription.created':
      return `${direction} call transcript added`
    default:
      return `${direction} call`
  }
}

interface AttachTranscriptInput {
  aircallCallId: number
  transcriptText: string
  language: string | null
  outcome?: {
    outcome: string
    sentiment: string
    suggestedFollowUp: string | null
    confidence: number
  }
}

async function attachTranscriptToCall(input: AttachTranscriptInput): Promise<void> {
  // Idempotent: find the call.ended (or any) Interaction for this call and
  // merge the transcript into its payload.
  const interaction = await db.interaction.findFirst({
    where: {
      type: 'call',
      payload: { path: ['aircallCallId'], equals: input.aircallCallId },
    },
    orderBy: { occurredAt: 'desc' },
    select: { id: true, payload: true },
  })
  if (!interaction) return

  const existingPayload = (interaction.payload as Record<string, unknown>) ?? {}
  if (existingPayload['transcriptText'] && !input.outcome) return // already attached

  await db.interaction.update({
    where: { id: interaction.id },
    data: {
      payload: {
        ...existingPayload,
        transcriptText: input.transcriptText,
        ...(input.language ? { transcriptLanguage: input.language } : {}),
        ...(input.outcome ? { aiOutcome: input.outcome } : {}),
      },
    },
  })
}

// ADR 0017: 90-day historic backfill on first-connect.
import { BACKFILL_FUNCTIONS as AIRCALL_BACKFILL_FUNCTIONS } from './backfill'
// CLAUDE.md §10: recurring sync that keeps the call mirror complete.
import { aircallSyncCalls } from './sync'

export const FUNCTIONS = [
  aircallEventReceived,
  aircallTranscribeFallback,
  aircallRecoverDisabledWebhook,
  aircallSyncCalls,
  ...AIRCALL_BACKFILL_FUNCTIONS,
] as const
