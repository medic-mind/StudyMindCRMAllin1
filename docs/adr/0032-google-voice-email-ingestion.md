# ADR 0032: Google Voice is ingested via its notification emails

- Status: Accepted
- Date: 2026-06-04
- Relates to: CLAUDE.md §10 (call → Contact linking), §14 (Gmail sync), the
  call-channel contact resolver `resolveOrCreateContactForCall`
  (`packages/core/src/contact/from-call.ts`).

## Context

The team uses Google Voice alongside Aircall, and wants Google Voice calls,
voicemails, and texts to land in the CRM the way Aircall calls do — logged on
the contact's timeline, with an unknown number auto-creating a lightweight
Contact (the call-channel exception, §16).

The blocker is that **Google Voice has no usable API**:

- **Consumer Google Voice** exposes no public developer API — no webhooks, no
  REST endpoint for calls/texts/voicemails/call-logs. None has ever shipped.
- **Google Voice for Workspace** has only an admin/provisioning API (assign
  numbers, manage users) via the Workspace Admin SDK. It gives no per-call
  event webhooks and no message/recording content; usage shows up only in the
  delayed, metadata-only Admin Reports audit log.
- Unofficial reverse-engineered libraries break constantly and violate Google's
  ToS — unacceptable for a CRM handling minors' data (CLAUDE.md §44).

What **is** reliable: Google Voice emails the linked mailbox from
`voice-noreply@google.com` for **voicemails** (transcript + audio attachment),
**missed calls**, and **inbound texts**. The CRM already runs a full Gmail sync
(CLAUDE.md §14, `packages/integrations/gmail/src/jobs.ts`). So Google Voice
ingestion is mostly *recognising and reshaping a subset of mail we already
pull* — not a new vendor integration.

## Decision

**Option A — ingest Google Voice notification emails through the existing Gmail
sync.** In `processMessage`, when a message is from `voice-noreply@google.com`
and the `google_voice.email_ingest_enabled` flag is on, we hand it to a
dedicated handler instead of the normal email path.

1. **Pure parser** (`packages/integrations/gmail/src/google-voice.ts`,
   unit-tested): classifies the email (`voicemail | missed_call | text |
   unknown`), extracts the counterparty name + number, best-effort-normalises
   the number to E.164, and pulls the transcript / text body. Parsing is
   best-effort and fails soft — an unrecognised Google Voice email is left to
   the ordinary email path.

2. **Handler** (`google-voice-handler.ts`): resolves-or-creates the Contact by
   number using the **shared** `resolveOrCreateContactForCall` (the same path
   Aircall uses, §10/§16); streams any voicemail audio to S3; writes a `call`
   (voicemail / missed call) or `message` (text) Interaction with
   `source: 'google_voice'` and a `needsManualReview` flag; audits
   `google_voice.message_ingested`.

3. **Team alert.** Voicemails and missed calls need a human to type up the
   summary / check the call (this channel is partly manual by design), so the
   handler posts a **best-effort Slack alert** to the configured default
   `SlackChannelOption` (or `SLACK_ALERTS_CHANNEL_ID`). The alert never throws —
   a missing Slack config must not fail the Gmail sync.

**Feature-flagged.** `google_voice.email_ingest_enabled` (release flag, default
off) gates the whole path so it stays inert until a Google Voice number is
actually pointed at a synced mailbox. With the flag off, behaviour is unchanged.

## Consequences

- **Reuses everything**: Gmail sync, S3 attachment storage, the call→Contact
  resolver, and the Slack alert primitive. No new dependency beyond a
  workspace edge (`integration-gmail → integration-slack`, allowed — only
  core→integrations and integrations→apps/web are forbidden, CLAUDE.md §5).
- **Limits (accepted).** We only see what Google Voice emails: it depends on the
  user keeping GV email notifications on; voicemail transcription is Google's,
  not our Whisper path; and an *answered* call with no voicemail may not be
  reported at all. Number normalisation is NANP-biased; an ambiguous number is
  logged unmatched and flagged for a human rather than guessed (never
  auto-merge, §41.1).
- **Idempotent.** Dedupe is the existing `processMessage` guard on
  `payload.gmailMessageId`; the Slack alert is idempotent on the Gmail message
  id.

## Alternatives considered

- **Workspace Admin SDK Voice API** — provisioning + delayed metadata only; does
  not deliver call events or content. Rejected: doesn't meet the goal.
- **Port the Google Voice number to Twilio / Aircall** — gives full real-time
  call webhooks + recordings and would reuse `resolveOrCreateContactForCall`
  unchanged. This is the recommended **upgrade path** if richer fidelity is
  needed later, but it changes telephony provider, so it is out of scope here.
- **Unofficial GV libraries** — ToS/again-and-supply-chain risk; rejected.
