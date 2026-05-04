# Runbook: Family billing contact change

Switching the billing contact on a Family — typically because of mid-term separation, bereavement, or a grandparent taking over — is an explicit, audited operation. The system never auto-transfers Stripe subscriptions or GoCardless mandates. See CLAUDE.md §6.1.

## When this runbook applies

- A parent has separated and the other parent will now pay.
- The original payer is unavailable (illness, bereavement) and a relative will take over.
- A Local Authority is taking over funding mid-placement (treat as an LA contract switch — see CLAUDE.md §43.2 — not a billing contact change).

## When it does **not** apply

- **Guardian dispute.** If the two parents disagree about who should pay, do not change anything. Escalate to the on-duty DSL via the safeguarding workflow (CLAUDE.md §42). Money disputes around minors are a safeguarding signal until proven otherwise.
- **Refund routing.** Refunds for charges captured before the change still flow back to the original payment method. See "Reconciliation impact" below.

## Prerequisites

Before any system change:

1. **Signed authority.** Either a signed email from the outgoing billing contact authorising the change, or a recorded call (Aircall) where they state the change. Upload the email as an attachment to the Family, or attach the call recording's S3 key to the Interaction. The audit entry will reference this.
2. **New billing contact identity verified.** They must already exist as a `Contact` on the Family, or be added first via the standard contact-create flow.
3. **Finance lead acknowledgement.** Two-person rule for billing changes (CLAUDE.md §33). Ops raises, finance signs off.

## Procedure

1. From the Family page, action menu → "Change billing contact". Select the new contact, enter the effective date, paste the authority reference (email message id or call id), and a free-text reason.
2. Submit. The system writes a `family.billing_contact_changed` Interaction (CLAUDE.md §6.1, §45) and an `AuditLogEntry` capturing actor, target, before/after.
3. The old subscription and mandate are **not** touched. Confirm the banner reads "Old billing arrangements remain active — re-issue manually."

## Manual re-issue

Stripe and GoCardless artefacts must be reissued by hand:

- **Stripe subscription.** In `outbound.ts` use `cancelSubscription({ subscriptionId, atPeriodEnd: true, reason: 'billing_contact_changed' })`. Then create a new subscription against the new contact's customer record. Send a fresh Payment Link or Checkout Session for the next cycle.
- **GoCardless mandate.** The old mandate stays `active` until the outgoing contact cancels it. Send the new contact a hosted billing-request link. Reconciliation walks `replacedById` chains for historical events; an unrelated new mandate does not need that link set.
- Do not pause the original mandate without a confirmed new mandate in place — gaps in collection cause `at_risk` flagging.

## Reconciliation impact

Open `Allocation` rows for charges captured before the effective date stay attached to the original `Payment`. If a refund is later required, it routes to the original payment method (CLAUDE.md §8). The reconciliation engine treats payments as facts; we never rewrite history.

The nightly `finance/reconcile-all-families` job will surface a discrepancy if the old subscription is still charging after the effective date. Resolve by completing the cancellation step above.

## Comms

Send both contacts a confirmation. Templates live in `packages/ai/prompts/style/billing-change/`:

- **Outgoing contact.** Confirms the change is recorded, that any future charges will go to the new contact, and that historical refunds (if any) still come back to their card or bank.
- **Incoming contact.** Confirms they are now the billing party, what they will be charged and when, and how to set up payment.

Drafts are AI-assisted; the agent edits and sends from Trengo or Gmail as appropriate.

## Audit checklist

- [ ] `family.billing_contact_changed` Interaction visible on the Family timeline.
- [ ] AuditLogEntry references the authority artefact (email id or call id).
- [ ] Old Stripe subscription cancelled or scheduled to cancel.
- [ ] New Stripe customer + subscription or Payment Link issued.
- [ ] New GoCardless mandate created, status `active` or `pending_submission`.
- [ ] Both contacts have received the confirmation comms.
- [ ] Finance lead has signed off in the Family thread.
