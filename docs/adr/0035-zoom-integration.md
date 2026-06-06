# ADR 0035 — Zoom integration for webinar links + recordings

- Status: Accepted
- Date: 2026-06-09

## Context

The weekly-webinar system (ADR 0031) emails a Zoom join link that staff paste in
by hand and rotate every ~4 weeks (so a lapsed member can't reuse an old link).
Ops asked whether the CRM can connect to Zoom directly to (a) generate the join
link per class, (b) make each meeting open to all with recording on, and (c)
email the recording to the class after each session and optionally remove it from
Zoom.

## Decision

1. **Zoom Server-to-Server OAuth, dependency-free.** A small client
   (`packages/integrations/zoom`) gets an account token and calls the REST API
   over `safeFetch` (SSRF allowlist — `zoom.us`, `api.zoom.us`). No SDK, so no new
   npm dependency. Credentials (`ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` /
   `ZOOM_CLIENT_SECRET`) come from env; `isConfigured()` lets every caller **fail
   closed** when Zoom isn't set up — the whole feature is dormant until then.

2. **App-generated links.** `webinar.class.generateZoomLink` (Manager+) creates a
   **recurring** meeting (type 8) with `join_before_host`, `approval_type: 2`
   (no registration — open to all), `waiting_room: false`, and
   `auto_recording: 'cloud'`. We store `zoomLink` + `zoomMeetingId` on the class
   and clear the rotation reminder. Hand-pasting a link still works.

3. **Recordings distribution, off by default.** An hourly job
   (`webinar/send-recordings`) fetches each class meeting's cloud recording,
   emails the share link to the **active** mailing list (via `sendSystemEmail`,
   from info@studymind.co.uk), and logs a `WebinarRecordingDispatch` row keyed on
   the occurrence UUID for idempotency. Gated by `WebinarSettings.zoomSendRecordings`
   (default OFF).

4. **Deletion is opt-in and reversible.** When `zoomTrashAfterSend` is on (default
   OFF) the recording is moved to **Zoom Trash** (recoverable for 30 days), never
   hard-deleted, and **only after a successful send to ≥1 recipient** (CLAUDE.md
   §34 — make external mutation reversible, audited). Audited as
   `webinar.recording_trashed`.

## Consequences

- Live use needs a Zoom Server-to-Server OAuth app with `meeting:write` and
  `recording:read`/`recording:write` (+ delete) scopes; nothing runs without it.
- Recurring-meeting recordings are fetched for the latest occurrence; the
  per-occurrence UUID guards against re-sending.
- Future: stream the recording file to S3 before trashing (mirror the Aircall
  retention pattern, §10) so we keep a copy independent of Zoom; surface a
  recordings tab per class.
