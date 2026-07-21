// Pure sender-gate for purchase-alert emails (ADR 0048).
//
// We pick purchases up from the payment-alert emails that already arrive in a
// connected mailbox (e.g. Stripe receipts / "payment received" notifications) —
// NO Stripe API in the CRM. The gate is cheap and deterministic so no AI runs
// on ordinary mail: only mail from a configured alert sender is handed to the
// purchase handler (which does the AI extraction at the worker boundary).
//
// The sender list is configurable via PURCHASE_ALERT_SENDERS (comma-separated),
// because which address the alerts come from varies by setup (receipts@ vs
// notifications@ vs a platform's own order-confirmation address). Sensible
// Stripe defaults are used when unset. A `receipts+acct_…@stripe.com` style
// address matches its base `receipts@stripe.com` too (Gmail sub-addressing).

const DEFAULT_SENDERS = ['receipts@stripe.com', 'notifications@stripe.com']

/** The configured alert senders (lower-cased), or the Stripe defaults. */
export function purchaseAlertSenders(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env['PURCHASE_ALERT_SENDERS'] ?? '').trim()
  const list = raw
    ? raw
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_SENDERS
  return list
}

/** Strip a `+tag` sub-address from the local part: `receipts+x@d` → `receipts@d`. */
function baseAddress(addr: string): string {
  const at = addr.indexOf('@')
  if (at < 0) return addr
  const local = addr.slice(0, at)
  const plus = local.indexOf('+')
  const bareLocal = plus < 0 ? local : local.slice(0, plus)
  return `${bareLocal}@${addr.slice(at + 1)}`
}

/** True when any parsed From address matches a configured alert sender. */
export function isPurchaseAlertSender(
  fromAddrs: readonly string[],
  senders: readonly string[] = purchaseAlertSenders(),
): boolean {
  const wanted = new Set(senders.map((s) => s.trim().toLowerCase()))
  return fromAddrs.some((a) => {
    const addr = a.trim().toLowerCase()
    return wanted.has(addr) || wanted.has(baseAddress(addr))
  })
}
