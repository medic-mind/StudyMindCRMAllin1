# @studymind/integration-trengo

Trengo integration. Service-specific quirks live here, close to the code that owns them.

See CLAUDE.md Section 7 for the integration shape, and the service-specific section for Trengo (Sections 8–16).

## Outbound coverage (CRM → Trengo)

`client.ts` is the single place every Trengo write lives. Reply, close, reopen,
assign, labels (attach/detach/create), internal notes, send-with-attachments,
and start-a-new-conversation all route through it. Every outbound is two-phase
(`pending_send` Interaction first, then the API call) and recovered by the
`trengo/retry-pending-send` cron, so a transient Trengo failure never loses the
action.

### Assumed endpoints to verify against a live workspace

A few endpoints are driven from the CRM but could not be exercised against a
real Trengo workspace from CI. They follow the Trengo v2 conventions and are
**isolated to `client.ts`** + pinned by `client.test.ts`, so correcting any of
them is a one-line change with no ripple:

| Method | Assumed request |
|---|---|
| `uploadMedia` | `POST /media` (multipart `file`) → `{ data: { id } }` |
| `sendMessage` attachments | `POST /tickets/:id/messages` with `attachment_ids: number[]` |
| `createConversation` (primary) | `POST /messages` with `{ channel, recipient, body, custom_fields }` → `{ message: { id, ticket_id } }` |
| `createConversation` (fallback chain, runs when the primary is rejected 4xx) | `GET /channels` → pick by `type` (`WA_BUSINESS`/`SMS`/`EMAIL`/`CHAT`) → `POST /channels/:id/contacts {identifier}` (upserts by identifier) → `POST /tickets {channel_id, contact_id}` → `POST /tickets/:id/messages` |
| `attachLabel` / `detachLabel` | `POST /tickets/:id/labels {label_id}` / `DELETE /tickets/:id/labels/:labelId` |
| `addInternalNote` | `POST /tickets/:id/notes {body}` |
| `listWaTemplates` | `GET /wa_templates` → `{ data: [{ id, title, message, status }] }` (approved WhatsApp HSM templates) |
| `sendWaTemplate` | `POST /wa_sessions` with `{ recipient_phone_number, hsm_id, params: [{key:"{{1}}", value}] }` — starts/refreshes the WhatsApp session with a template (valid outside the 24h window) |
| `listQuickReplies` | `GET /quick_replies` → `{ data: [{ id, title, message }] }` (canned responses — surfaced as the SMS templates) |
| `listChannels` | `GET /channels` → `{ data: [{ id, name, type }] }` |

If a live response differs, fix the method body in `client.ts` and the matching
expectation in `client.test.ts`.

## Historic import (`backfill.ts`)

The history import walks the **documented** ticket listing
(`GET /tickets?page=N` — developers.trengo.com/reference/list-all-tickets,
paginated via `meta.last_page` / `links.next`), then each ticket's messages
(`GET /tickets/:id/messages?page=N`). The original assumed
`GET /conversations?created_at_after=…` path is retained only as a one-shot
fallback when a workspace 404s the documented route. `/tickets` has no
server-side date filter, so the import window is enforced client-side on each
ticket's `created_at` (rows with no parseable date import anyway — fail open).
Message rows are parsed defensively (`body`/`message`/`text`; direction from
`direction` → `type` → `user_id` heuristic) and the parsing layer is pinned by
`backfill.test.ts`.

Each imported ticket is also replayed onto the `Conversation` head via
`applyEventToConversation` (closed tickets get a final `ticket.closed`
replay), so the comms centre / unified inbox shows imported history without
the separate conversation-heads migration.
