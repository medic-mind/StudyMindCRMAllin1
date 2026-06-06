// Settings → Invoicing (CEO / Senior Manager). Connect the B2B Invoices
// Platform: paste the API key + webhook secret, see the connection badge, and
// fire a live connection test. CLAUDE.md §20.1, §21.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { InvoicingSettings } from './InvoicingSettings'

export const dynamic = 'force-dynamic'

const CONFIG_ROLES = new Set(['ceo', 'senior_manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Integrations', href: '/settings/integrations' },
  { label: 'B2B Invoicing', href: '/settings/invoicing' },
]

export default async function InvoicingSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !CONFIG_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Invoicing platform" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to CEO and Senior Manager — they hold the invoicing credentials.
          </p>
        </PageBody>
      </>
    )
  }

  const caller = await createServerCaller()
  // Never let a status lookup failure 500 the whole page — fall back to a
  // safe "not configured" view so the credential form still renders.
  let status
  try {
    status = await caller.invoicing.config.status()
  } catch {
    status = {
      baseUrl: 'https://b2b.studymind.co.uk',
      configured: false,
      webhookSecretConfigured: false,
      apiKeyLast4: null,
      eventsCursor: null,
      streamCursor: null,
      customerCount: 0,
      invoiceCount: 0,
      lastEventAt: null,
      lastEventType: null,
    }
  }

  return (
    <>
      <PageHeader
        title="Invoicing platform"
        subtitle="Live two-way sync with the B2B Invoices Platform (b2b.studymind.co.uk). Customers, invoices, and payments stay in step across both apps."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <InvoicingSettings initial={status} />
      </PageBody>
    </>
  )
}
