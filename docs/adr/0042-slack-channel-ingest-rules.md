# ADR 0042 — Slack channel-aware ingestion rules + pull robustness

Date: 2026-07-17
Status: Accepted

## Context

The Slack ingest (ADR 0034) archives customer mentions from every channel the
bot is in. Two problems surfaced in production:

1. **Messages vanished non-deterministically.** The recurring pull walked
   channels alphabetically inside one try-less loop: the first channel error
   (Slack's Tier-3 `ratelimited` on `conversations.history`/`replies` is
   routine on a workspace this size) aborted the entire tick, silently
   dropping every later-alphabet channel. Separately, `conversations.history`
   returns thread ROOTS only, so a fresh reply on a thread started before the
   30-minute lookback window was structurally invisible to the pull — only an
   Events-webhook deployment ever saw those replies. Net effect: "some
   messages/replies are captured, some never", with no error surfaced.

2. **Channel intent was ignored.** The team's channel names carry meaning —
   a call summary posted in `#complaintcallsummaries` IS a complaint being
   logged — but the ingest treated every channel identically, so staff had to
   re-type complaints into the CRM by hand.

## Decision

**Robustness.** Channel walks are isolated (per-channel try/catch; failures
are counted in the run result as `failedChannels` and logged). Slack read
calls retry 429/`ratelimited` honouring `Retry-After`, bounded. The default
lookback rises to 120 minutes (overlap costs only DB dedupe — matched and
parked messages short-circuit before any AI or API spend). Each tick adds an
**old-thread scan**: roots up to `SLACK_SYNC_THREAD_SCAN_DAYS` (7) days old
whose `latest_reply` falls inside the window get their new replies walked via
`conversations.replies?oldest=<window>`.

**Channel rules.** A contact-linked mention ingested from a channel whose
name contains `complaint` also opens a `Complaint` (open / medium / system-
authored, title from the summary's first line, AI category mapped onto the
complaint presets where it fits), with the same contact timeline note and
`complaint.created` audit row as the human log flow. Idempotent on the new
`Complaint.sourceKey` column (`slack:<channelId>:<ts>`, unique) so the
webhook, pull, backfill and relink paths converge on one complaint. Gated to
messages ≤7 days old so historic backfills never flood the Active queue.
Best-effort: a complaint write failure never blocks the mention archive.
Account-only mentions (no contact) never raise — there is nobody to log the
complaint against; they stay in the normal tray/timeline flow.

Name-substring matching (not a channel-id allowlist) is deliberate: renamed
or newly created complaint channels (`#b2bcomplaints`) keep working with no
code or settings change. A DB-configurable per-channel rules table can layer
on later if more behaviours (e.g. auto-tasks from `#jobmarket`) are wanted.

## Consequences

- One Slack message in a complaint channel = one complaint, visible on
  `/complaints` within a pull tick, worked/resolved exactly like a
  hand-logged one.
- The pull's run result now says when a channel failed instead of reading as
  a quiet success — the first place to look when "messages aren't showing".
- `Complaint.sourceKey` is nullable and unique; human-logged complaints keep
  it null. Forward-only migration `20260717090000_add_complaint_source_key`.
