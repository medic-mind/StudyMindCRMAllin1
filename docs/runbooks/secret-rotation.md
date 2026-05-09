# Runbook: Secret rotation

Secrets in StudyMind CRM live in Railway env vars, mirrored from the 1Password vault `StudyMind CRM Prod`. Rotation is scheduled, not reactive. See CLAUDE.md §44.2.

## Cadence

| Provider / secret | Cadence | Owner |
|---|---|---|
| Clerk app keys (publishable + secret) | Yearly | Tech lead |
| Stripe webhook signing secret | Quarterly | Tech lead |
| Stripe restricted API key | Quarterly | Finance lead |
| GoCardless webhook secret | Quarterly | Tech lead |
| GoCardless access token | Quarterly | Finance lead |
| OpenAI API key | Monthly review, rotate on suspicion | Tech lead |
| Per-agent Gmail OAuth refresh token | Every 90 days (forced re-consent) | Each agent |
| Per-agent Trengo API token | Every 90 days (CLAUDE.md §11) | Each agent |
| Aircall API token | Quarterly | Ops manager |
| Slack signing secret | Yearly (Slack rotates rarely) | Tech lead |
| Asana PAT | Yearly | Ops manager |
| Booking site service account token | Quarterly | Tech lead |
| Zapier inbound bearer token (`/api/webhooks/lead`) | Quarterly (CLAUDE.md §16) | Ops manager |
| AWS access keys (CI deploy role) | Quarterly | Tech lead |
| AWS KMS CMK | AWS-managed annual auto-rotation | Tech lead |
| Railway project tokens | Yearly | Tech lead |
| 1Password service account token | Yearly | Tech lead |
| PagerDuty integration keys | Yearly | On-call lead |

A calendar entry per secret lives in the shared `crm-secret-rotation` calendar, owned by the tech lead. The calendar is the source of truth; this table mirrors it.

## Procedure

The pattern is the same for every secret.

1. **Generate the new secret** in the provider's console. Do not re-use a previously rotated value.
2. **Store it in 1Password** in the same item, using the "Add new value" feature so the previous value is retained for rollback. Note the rotation date in the item notes.
3. **Set the new value in Railway** for the affected environment(s):
   ```bash
   railway variables set STRIPE_WEBHOOK_SECRET="<new>" --service web --environment production
   railway variables set STRIPE_WEBHOOK_SECRET="<new>" --service worker --environment production
   ```
   Most secrets are needed by both `web` and `worker` — check `.env.example` for usage.
4. **Redeploy.** Railway redeploys automatically on env change. Confirm the deploy goes green and `GET /api/health` returns 200.
5. **Confirm health.** Send a test event from the provider (Stripe Dashboard → Webhooks → Send test event, etc) and verify a `ProviderEvent` row lands. For non-webhook secrets, exercise the affected flow (send a test outbound message, draft an AI reply, etc).
6. **Revoke the old secret** in the provider's console. Do **not** revoke before step 5 confirms the new one works.
7. **Audit.** Write a brief Slack post in `#crm-eng` with what was rotated and when. The Railway deploy and 1Password change history are the durable audit trail.

For per-agent OAuth and Trengo tokens, the agent re-consents themselves through the in-app settings flow. We surface a banner 14 days before expiry (CLAUDE.md §11). Expired tokens fail closed; outbound messages stay in `pending_send`.

### Trengo webhook secret

Use the helper script — it generates a fresh secret, posts the webhook to Trengo (or prints the manual UI checklist if the workspace API path is unavailable), and verifies the public endpoint rejects mismatched signatures with a 400.

```bash
pnpm setup:trengo
```

Mirror the printed `TRENGO_WEBHOOK_SECRET` to Railway env and 1Password. The endpoint must already be deployed for the verify step to pass.

## If a secret leaks

Treat as a Sev 2 minimum. Sev 1 if the leaked secret is Stripe live-mode, GoCardless live token, AWS access key, or anything that can read safeguarding data.

1. **Revoke immediately** in the provider's console. Do not wait to generate the replacement.
2. **Rotate** following the procedure above. Acceptance of brief downtime on the affected flow is expected during a Sev 1.
3. **Audit-log review.** Query `AuditLogEntry` and provider activity logs for any use of the leaked credential between leak time and revocation. Use 1Password's audit log to determine when the secret was last accessed legitimately so you can scope the window.
4. **Customer comms.** Only with comms lead approval (CLAUDE.md §25.3). For payment data exposure, the DPO is consulted on ICO notification within the 72-hour window.
5. **Postmortem.** Sev 1 always gets a postmortem within 5 working days. The action items typically include narrowing the secret's scope (e.g. moving from a full-access Stripe key to a restricted key with the minimum permissions needed).

If the leak vector was a developer machine, the device is wiped before re-issue. If it was a third party (vendor breach), file a vendor risk record in `docs/compliance/vendor-incidents.md`.
