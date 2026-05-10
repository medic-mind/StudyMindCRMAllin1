// Issue refund. CLAUDE.md §8 — chargeId + reasonCode + optional partial
// amount. The mutation persists a RefundIntent first, then issues the
// Stripe call, then audits. We keep the page a thin wrapper around the
// client form so server-side auth + RBAC still gates the route.

import { IssueRefundForm } from './form'

export default function IssueRefundPage() {
  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold tracking-tight">Issue refund</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Refunds are irreversible. Confirm the charge id and reason before
        submitting; the audit log captures actor, amount, and reason for every
        refund attempt.
      </p>
      <div className="mt-6 rounded-md border border-neutral-200 bg-white p-4">
        <IssueRefundForm />
      </div>
    </div>
  )
}
