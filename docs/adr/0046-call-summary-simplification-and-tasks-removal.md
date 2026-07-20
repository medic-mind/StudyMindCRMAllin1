# ADR 0046 — Call-summary simplification, Tasks feature removal, and the webinar reminder rework

Date: 2026-07-20
Status: accepted
Supersedes: ADR 0039 (info-pack library + three-step call-summary wizard). Retires
the Asana integration (ADR/§13) and the CRM Tasks feature.

## Context

Two things had grown past their usefulness:

1. **The call-summary flow had become a mini email client.** The wizard
   (ADR 0039) forked into self-send vs "hand to a VA", composed email (with
   templates, AI drafts, and PDF/info-pack attachments), sent WhatsApp/SMS via
   Trengo, logged an internal note, opened follow-up tasks, and finally posted
   to Slack. In practice the team wanted the opposite: **type what happened on
   the call, have it recorded on the customer's CRM record, and have it show up
   in the `#callsummaries` Slack channel.** Everything else duplicated work the
   Communications Hub (email/`/mail`, Trengo inbox) already does better.

2. **The Tasks feature duplicated work tracked elsewhere.** Beyond the standalone
   `/tasks` page, tasks were created by ~10 features (Asana sync, churn scoring,
   complaints, at-risk, forwarding, inbox, board cards, business accounts). The
   operator's decision (2026-07) was to remove the Tasks feature across the CRM.

## Decision

### 1. Call summaries: type → record → Slack (only)

The wizard collapses to a single form (`call-summary-wizard.tsx`) on all three
surfaces (contact page, board card, `/call-summaries`): an optional outcome
(answered / voicemail / no answer) + the typed summary. On submit the tRPC
`callSummary.add` procedure (`contact.callSummary.add` / `card.callSummary.add`)

- writes a `call_summary` Interaction on the customer's record
  (`addContactCallSummary` / `addCallSummary`, unchanged), and
- posts to the operator-routed `#callsummaries` channel best-effort
  (`postCallSummaryToSlack` → `buildCallSummarySlackBlocks` →
  `resolveTopicChannelId(db, 'call_summary')`, ADR 0033).

A Slack failure never loses the CRM record. **No customer message is ever sent
from the CRM** — email, WhatsApp/SMS, templates, PDFs, AI drafting, and the VA
task hand-off are all gone.

**Removed:** the `contact.callSummary.{send,waTemplates,mailboxes,logInternal,
announceToSlack,draftFromCall,draftInternalNote}` and `card.callSummary.
{availability,send,draftFromCall,preview}` procedures; the `Call summary
templates` subsystem (`CallSummaryTemplate` table, router, `/settings/call-summary-templates`,
`/api/call-summary-templates/[id]/pdf`); the `Info-pack` document library
(`InfoPackDocument` table, `infoPack.*` router, `/settings/documents`,
`/api/info-packs/[id]/file`); the multi-channel senders + attachment resolvers.
The Slack block builder collapses to one layout (headline outcome + name + phone
+ email, summary body, "logged by"). The `waTemplates` endpoint moved to
`interaction.trengo.waTemplates` (still used by the Trengo composer).

### 2. Tasks feature removed across the CRM

`Task` model + `TaskStatus` enum dropped; `/tasks` page, `task.*` router,
`packages/core/src/task`, and the `NewTaskDialog` are deleted. Task creation was
stripped from every feature that had it, **keeping each feature otherwise
working**:

- **Churn scoring** keeps computing + persisting the score and refreshing the
  at-risk derivation; it no longer opens a retention task.
- **Asana** existed only to sync tasks → the whole integration is deleted
  (`packages/integrations/asana`, `/api/webhooks/asana`, `AsanaWebhook`,
  `asana/event.received`).
- **Complaints / at-risk / forwarding / inbox / board cards / business accounts**
  lose their optional-task sub-forms; the core feature (log complaint, flag
  at-risk, forward email, etc.) is unchanged.
- **`CardSubtask`** (board card checklist) is a separate model and stays.

`task.assignableUsers` was a shared user-picker used by surviving features
(card assignee, team + mail-account members, conversation @mentions); it moved
to `team.assignableUsers`. The chat `<~task:id>` ref type is retained
forward-only (DB enum §19) but no longer offered or resolved.

### 3. Webinar Zoom-rotation reminder → assigned person + on-system reminder

Auto-rotation is unchanged. The **fallback** (auto-rotate off / Zoom not
connected / rotation failed) previously created an unassigned `Task`; it now
**emails a single configured "assigned person"** (`WebinarSettings.
rotationReminderEmail`, set in Webinars → Settings, via the existing
system-Gmail path) **and** surfaces the due links in an **on-system reminder
panel** on the Webinars overview (derived from `zoomRotationDue`, never stored).
Engine: `runZoomRotation` (`apps/web/lib/webinar/zoom-reminder-service.ts`).

## Consequences

- One source of truth for "what was said on this call": the CRM record +
  `#callsummaries`. The flow is fast and unambiguous.
- Forward-only migration `20260720120000_remove_tasks_and_call_summary_libraries`
  drops the `Task`/`TaskStatus`, `AsanaWebhook`, `CallSummaryTemplate`, and
  `InfoPackDocument` schema, and adds `WebinarSettings.rotationReminderEmail`.
  Historical `call_summary` / `call_summary_sent` Interaction enum values are
  retained (append-only enums); old `call_summary_sent` rows still render.
- The AI call-summary-draft prompts remain as unused library code in
  `packages/ai` (removing them risks the barrel/evals; they are harmless).
- Gate `pnpm typecheck && pnpm lint && pnpm test && pnpm policy:check && pnpm
  build` all green.
