// Direct Debits working tabs (ADR 0038): /direct-debits/plans · payments ·
// customers · issues. Real routes (not query params) so the sidebar children,
// deep links, and back button behave. Unknown tabs 404.

import { notFound, redirect } from 'next/navigation'

import type { DdTab } from '@/components/finance/gocardless/DirectDebitWorkspace'

import { DirectDebitsPage } from '../workspace-page'

export const dynamic = 'force-dynamic'

const TABS = new Set<DdTab>([
  'plans',
  'payments',
  'customers',
  'payouts',
  'activity',
  'issues',
])

export default async function Page({
  params,
}: {
  params: Promise<{ tab: string }>
}): Promise<JSX.Element> {
  const { tab } = await params
  // Chasing merged into Issues (ADR 0045 amendment) — keep old links working.
  if (tab === 'chasing') redirect('/direct-debits/issues')
  if (!TABS.has(tab as DdTab)) notFound()
  return DirectDebitsPage({ tab: tab as DdTab })
}
