# ADR 0039 — Info pack document library + the three-step call-summary wizard

Date: 2026-06-10
Status: accepted

## Context

Agents follow most calls with an information pack or brochure (UCAT pack,
tutoring brochure, …), usually attached to an email, or linked from a Trengo
WhatsApp template. Two problems:

1. **The packs had no home in the CRM.** They lived on agents' machines and
   were re-uploaded per send (the call-summary panel only offered per-contact
   documents, uploaded invoices, template PDFs, and device uploads).
2. **The send flow didn't match how agents actually work.** The single
   "pick channels then send" panel composed ONE body for every channel, hid
   the team's approved Trengo WhatsApp templates (agents had to open Trengo
   to use them), and made it easy to double-send a pack — once as an email
   PDF and again as a link inside the WhatsApp template.

## Decision

### 1. `InfoPackDocument` — a shared PDF library

A new operator-managed catalogue (Settings → Documents, Manager+; reads any
staff): name (unique), description, sortOrder, and the PDF inline in Postgres
(≤8 MB, magic-number sniffed) — the same byte-storage approach as
`CallSummaryTemplate.pdfData`, keeping self-hosted deploys S3-free. Served
inline at `/api/info-packs/[id]/file` (authenticated). tRPC `infoPack.*`,
all writes audited (`info_pack.*` in the events registry).

The library is surfaced as one-click attachments in the call-summary email
step (a new `infoPack` member of `CallSummaryAttachmentRef`).

### 2. The wizard: email → text/WhatsApp → internal note

`apps/web/components/contact/call-summary-wizard.tsx` replaces the old
two-step panel on BOTH surfaces (contact page + board card modal — the two
`CallSummarySection.tsx` files are now thin wrappers, so the flows can never
drift apart):

- **Step 1 — "Send an email?"** Compose from templates / AI draft / quick
  replies; attach library packs, contact documents, invoices, device files;
  optional subject used when the contact has no Gmail thread yet (the email
  sender now falls back to `sendEmail` — a fresh thread — instead of
  skipping).
- **Step 2 — "Send a text or WhatsApp?"** Channel pick (WhatsApp / SMS).
  WhatsApp surfaces the agent's approved Trengo templates exactly as Trengo
  does: list from `GET /wa_templates`, per-`{{n}}`-param inputs ({{1}}
  defaults to the contact's first name), live preview, sent as a real HSM via
  `POST /wa_sessions` (`sendWhatsAppTemplate`, two-phase `pending_send`
  Interaction like every Trengo outbound, recovered by
  `trengo/retry-pending-send`). **No PDF picker on the template path** —
  the templates already carry the pack links; attaching the PDF again would
  duplicate them (the orchestrator enforces this, not just the UI). Free
  text / SMS keep the existing thread-or-start-conversation path and CAN
  carry attachments.
- **Step 3 — internal note** (+ optional Slack post + VA follow-up task),
  unchanged from the previous flow.

Everything still sends in ONE audited fan-out: `sendC(ontact|ard)CallSummary`
gains `channelBodies` (per-channel body overrides — the email and the text
are composed separately), `emailSubject`, and `whatsappTemplate`. Channels
remain best-effort and independent.

## Consequences

- One library, zero re-uploads, and the duplication trap is structurally
  closed (template ⇒ no attachments, decided in `packages/core`).
- The Trengo `wa_templates` / `wa_sessions` endpoints are assumed from
  Trengo's public API and pinned by `client.test.ts` (the repo's existing
  convention for CRM-driven endpoints we can't exercise in CI). Listing
  fails soft (`available:false` → the UI offers free text), sending fails
  closed into `pending_send` + the retry cron.
- A declined email + declined text records no `call_summary` Interaction —
  the internal note (step 3) is the record for no-contact calls.
- Forward-only schema addition (`20260616120000_add_info_pack_documents`),
  no changes to existing tables.
