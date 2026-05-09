# Runbook: Disaster recovery

The script that backs CLAUDE.md §46. If you are reading this during an incident, jump to the checklist appendix and copy it into `#crm-incidents`. Then come back for detail.

Recovery objectives (CLAUDE.md §46.1): RPO 5 minutes for Postgres, 24 hours for S3. RTO 2 hours for the web app, 4 hours for full integration recovery.

## First 30 minutes

1. **Declare a Sev 1.** PagerDuty → "Declare incident" → severity 1, title `crm-dr-<date>`. The on-call primary becomes incident commander unless the CTO assumes the role.
2. **Page the CTO and the tech lead.** Use PagerDuty escalation, not Slack DM. DR rehearsals have shown DMs get missed.
3. **Freeze deploys.** In Railway, set the project deploy lock on. In GitHub, apply the `deploy-freeze` label to the repo settings (this fails any new merge to `main`).
4. **Open `#crm-incidents`.** Pin the running document. Update every 30 minutes minimum, more often if state is changing.
5. **Establish ground truth.** Capture the disaster moment as a UTC timestamp. Everything that follows references this `T0`.

## Hours 1–4: restore the platform

### Step 1 — Provision a fresh Railway environment

Pre-conditions: `railway.json` is in repo at the SHA running at `T0`.

```bash
railway environment create crm-recovery
railway link --environment crm-recovery
railway up --detach
```

Verify: `railway status` shows three services (`web`, `worker`, `postgres`) provisioning.

If this step fails (Railway regional outage), bring up the standby project in the secondary region documented in `scripts/dr/railway-standby.md`.

### Step 2 — Restore Postgres

Pre-conditions: Step 1 has produced a target database with no app traffic yet.

Two paths. Prefer PITR.

```bash
# Path A: Railway PITR (preferred, RPO ~5 min)
railway db restore --to "<T0 minus 5 minutes ISO>" --target crm-recovery

# Path B: Logical dump from S3 (fallback if Railway PITR is unavailable)
aws s3 cp s3://studymind-crm-backups-prod/postgres/<latest>.dump .
pg_restore --no-owner --dbname "$DATABASE_URL" <latest>.dump
```

Verify: `select max("createdAt") from "Interaction"` is within 5 minutes of `T0` for path A, within 24 hours for path B. Record the actual recovery point in the incident doc.

Rollback: if the restore is corrupt, drop the database, retry one timestamp earlier. Do not proceed to Step 3 with a partial restore.

### Step 3 — Restore S3

Pre-conditions: production S3 buckets are versioned with cross-region replication to `eu-west-1` (CLAUDE.md §46.2).

```bash
# If primary region is gone, repoint the app to the replica
aws s3api list-buckets --region eu-west-1 | grep studymind-crm-prod-replica
# Update the S3_BUCKET env var in Railway to the replica bucket
```

Verify: `aws s3 ls s3://<bucket>/aircall/recordings/ | head` returns recent objects.

### Step 4 — Bring up `web` and `worker`

Pre-conditions: Steps 1–3 verified. Pin to the SHA running at `T0` (find it in the Railway deploy history or the Sentry release marker).

```bash
railway up --service web --detach --commit "<T0 SHA>"
railway up --service worker --detach --commit "<T0 SHA>"
```

Verify: `GET /api/health` returns 200 with the pinned SHA. Sign in via Clerk dev (Clerk is provider-managed and unaffected unless Clerk itself is the disaster).

Communicate: post the recovery URL to `#crm-incidents`. Do **not** route public DNS to it yet.

## Hours 4–24: replay, reconcile, communicate

### Step 5 — Reconnect webhooks

Pre-conditions: app is up at the recovery URL. Each provider needs its webhook target updated.

```bash
# Run them in order via the orchestrator (prompts between each step):
pnpm dr

# Or run individually (idempotent — re-uses an existing endpoint with our
# URL where the provider exposes CRUD):
pnpm dr:stripe
pnpm dr:gocardless
pnpm dr:aircall
pnpm dr:trengo      # prints a manual UI checklist; Trengo has no CRUD API
pnpm dr:slack       # prints a manual app-config checklist
pnpm dr:asana       # recreates per-project webhooks for the allowlist
pnpm dr:gmail       # renews users.watch for every connected mailbox
pnpm dr:booking     # verifies pull connectivity (no webhook to register)
```

Each script confirms the webhook is reachable and signed correctly before reporting success. Verify in the provider dashboard that the latest test event landed.

### Step 6 — Replay `ProviderEvent`

Pre-conditions: webhooks reconnected. `ProviderEvent` rows from the recovery point onward exist in the restored DB.

```bash
pnpm dr:replay --from "<recovery point ISO>" --to "<T0 ISO>"
```

The replay job is idempotent on `(provider, eventId)` (CLAUDE.md §7.1). It re-enqueues each event into Inngest. Watch the Inngest dashboard for queue depth — it will spike, then drain.

Verify: queue drains to baseline within 90 minutes. Spot-check Interactions for affected Families.

### Step 7 — Reconcile

Trigger `finance/reconcile-all-families` manually from the Inngest dashboard. Surfaces every discrepancy opened during the gap. Finance lead works the discrepancy backlog as normal.

### Step 8 — Cut over DNS

Pre-conditions: Steps 1–7 green. CTO approval explicit in `#crm-incidents`.

Update the `crm.studymind.co.uk` CNAME to the recovery environment. TTL is 60s. Watch Sentry and Axiom for error spikes.

### Step 9 — Communicate restoration

Internal: `#crm-incidents` post-restoration summary, plus a brief in `#crm-eng`. External: only with comms lead approval (CLAUDE.md §25.3). LA contracts may have notification clauses — the comms lead checks `docs/compliance/la-notification-matrix.md` before any external message.

## Postmortem

Sev 1 always gets a postmortem within 5 working days (CLAUDE.md §25.3). DR-specific items: was the actual recovery point within RPO, was the actual recovery time within RTO, were any scripts in `scripts/dr/` out of date.

## Rehearsal

Quarterly. The most recent rehearsal date and result live below. Update on every rehearsal.

- **Last rehearsal:** _to be filled by the next rehearsal_
- **Result:** _to be filled_
- **RPO actual / RTO actual:** _to be filled_

## Appendix: incident channel checklist

Copy this block into `#crm-incidents` as the running document.

```
DR incident <date>
T0:                           <UTC ISO>
Incident commander:           <name>
Recovery environment:         <railway env>
Recovery point achieved:      <UTC ISO>
Recovery time achieved:       <minutes>

Steps:
[ ] 1. Sev 1 declared, CTO + tech lead paged, deploys frozen
[ ] 2. Railway recovery environment up
[ ] 3. Postgres restored (PITR / dump): _________
[ ] 4. S3 restored (primary / replica): _________
[ ] 5. web + worker up at pinned SHA: _________
[ ] 6. /api/health 200 with correct SHA
[ ] 7. Webhooks reconnected: stripe, gocardless, aircall, trengo, slack, asana, gmail, booking
[ ] 8. ProviderEvent replay started
[ ] 9. ProviderEvent replay drained
[ ] 10. finance/reconcile-all-families run, discrepancies triaged
[ ] 11. DNS cut over (CTO approval)
[ ] 12. External comms (comms lead approval)
[ ] 13. Postmortem ticket opened
```

## Post-deploy smoke (CLAUDE.md §24.1)

Every production and staging deploy is followed by a synthetic Stripe webhook smoke that posts a signed `invoice.payment_failed` event and asserts the resulting `ProviderEvent` row appears within 30 s.

- Workflow: `.github/workflows/post-deploy-smoke.yml`
- Script: `scripts/smoke/stripe-smoke.ts`
- Health probe: `/api/health`
- Verification endpoint: `/api/internal/smoke/last-provider-event`
- Required secrets: `STRIPE_TEST_WEBHOOK_SECRET`, `SMOKE_ADMIN_TOKEN`

If the smoke fails after a deploy, the on-call engineer rolls the Railway service back via the dashboard one-click and opens a Sev 2 incident.

## Infrastructure as code (CLAUDE.md §46.2)

KMS CMKs, S3 buckets, lifecycle rules, cross-region replication, and the IAM policies bound to the Railway services are managed in `infra/terraform/`. See `infra/terraform/README.md` for plan/apply/destroy. State backend: S3 + DynamoDB lock; bootstrapped manually.

When provisioning a recovery environment, run `terraform apply -var-file=env.<env>.tfvars` against a fresh workspace; the replica buckets in eu-west-1 are already populated via cross-region replication and so are recoverable independently of the primary region.
