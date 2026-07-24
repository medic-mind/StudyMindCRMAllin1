// Slack → Complaints auto-ingestion was REMOVED (2026-07, operator decision).
//
// Complaints are now logged in the CRM only (Complaints hub / a customer's
// page): staff pick a CRM customer or type a manual name + phone, and logging
// the complaint posts it to #complaintcallsummaries via the connected bot and
// anchors a thread. Slack messages are NEVER turned into Complaint rows anymore.
//
// This function is retained as a no-op so the ingestion call sites (live
// webhook / pull / backfill / relink) keep compiling without churn — they still
// archive Slack mentions as `slack_summary` interactions; they just never open a
// Complaint. Re-enabling would be an explicit ADR change, not a code accident.

export interface AutoComplaintInput {
  contactId: string | null | undefined
  channelId: string
  channelName: string | null
  slackTs: string
  messageText: string
  aiCategory?: string | null
  occurredAt: Date
  now?: Date
  cutoff?: Date
  isThreadReply?: boolean
}

export interface AutoComplaintResult {
  raised: boolean
  complaintId: string | null
}

/** No-op: Slack messages never open a Complaint (they are logged in the CRM). */
export async function maybeRaiseComplaintFromSlack(
  _input: AutoComplaintInput,
): Promise<AutoComplaintResult> {
  return { raised: false, complaintId: null }
}
