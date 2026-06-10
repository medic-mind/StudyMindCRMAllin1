// Legacy route (ADR 0038). The Direct Debit workspace moved to its own
// top-level section at /direct-debits with a master dashboard — there is
// exactly ONE home for Direct Debits, so this redirects (old bookmarks and
// the previous ?tab= deep links included).

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

const TAB_PATHS: Record<string, string> = {
  plans: '/direct-debits/plans',
  payments: '/direct-debits/payments',
  customers: '/direct-debits/customers',
  issues: '/direct-debits/issues',
}

export default async function LegacyDirectDebitPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}): Promise<never> {
  const { tab } = await searchParams
  redirect(TAB_PATHS[tab ?? ''] ?? '/direct-debits')
}
