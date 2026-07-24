// Recognise a Slack message that IS a call summary (vs a generic mention), so
// the CRM files it under the contact's Call Summaries rather than the Slack
// mentions list — "an AI or parser should recognise it and put it there,
// otherwise it's a Slack mention" (operator ask, 2026-07).
//
// Deterministic + free (no AI): a message is a call summary when it comes from a
// call-summary channel OR its content is call-summary-shaped — the team's
// labelled call-log format, or explicit call-outcome language ("voicemail", "no
// answer", "called twice", "call completed", …). Complaint channels are NOT call
// summaries — those become Complaints (ADR 0042). Pure so it's unit-tested and
// shared by the contact view-models + the Slack ingestion.

/** A call-summary channel: name contains "summar", excluding complaint channels. */
export function isCallSummaryChannelName(channelName: string | null | undefined): boolean {
  if (!channelName) return false
  const n = channelName.toLowerCase().replace(/^#/u, '')
  return n.includes('summar') && !n.includes('complaint')
}

// The team's labelled call-log format (Client Name and Number / Client Email /
// Call outcome / Summary / Hours / Actions …) — the shape both the team and the
// CRM's own Slack posts use.
const LABELLED_RE =
  /(client name and number|client email|call outcome|call summary|summary of (?:the )?call|hours booked|amount paid|suggested solution|actions? (?:taken|:))/u

// Explicit call-outcome / call-verb language.
const OUTCOME_RE =
  /\b(voicemail|vm left|left (?:a |him |her |them )?(?:a )?(?:voice\s*)?message|no answer|no-answer|did ?n[o']?t (?:answer|pick up|respond)|rang out|ring out|call(?:ed)? (?:once|twice|back|again|completed|him|her|them)|answered the call|call completed|no response|unreachable|couldn'?t reach|spoke on the (?:phone|call))\b/u

export function looksLikeCallSummary(input: {
  text: string | null | undefined
  channelName?: string | null | undefined
}): boolean {
  // A complaint-channel post is a Complaint (ADR 0042), not a call summary —
  // it's surfaced in the Complaints section, so never claim it as a call summary.
  const channel = (input.channelName ?? '').toLowerCase()
  if (channel.includes('complaint')) return false
  if (isCallSummaryChannelName(input.channelName)) return true
  const text = (input.text ?? '').toLowerCase()
  if (text.trim().length === 0) return false
  return LABELLED_RE.test(text) || OUTCOME_RE.test(text)
}
