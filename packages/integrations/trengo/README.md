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
| `createConversation` | `POST /messages` with `{ channel, recipient, body, custom_fields }` → `{ message: { id, ticket_id } }` |
| `attachLabel` / `detachLabel` | `POST /tickets/:id/labels {label_id}` / `DELETE /tickets/:id/labels/:labelId` |
| `addInternalNote` | `POST /tickets/:id/notes {body}` |
| `listWaTemplates` | `GET /wa_templates` → `{ data: [{ id, title, message, status }] }` (approved WhatsApp HSM templates) |
| `sendWaTemplate` | `POST /wa_sessions` with `{ recipient_phone_number, hsm_id, params: [{key:"{{1}}", value}] }` — starts/refreshes the WhatsApp session with a template (valid outside the 24h window) |

If a live response differs, fix the method body in `client.ts` and the matching
expectation in `client.test.ts`.
