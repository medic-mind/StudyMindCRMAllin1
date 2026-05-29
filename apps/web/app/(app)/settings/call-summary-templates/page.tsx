// Settings → Call summary templates (Manager+). Admin catalogue of prefill
// templates used by the contact page Call Summary panel. CLAUDE.md §20.1.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { CallSummaryTemplatesAdmin } from './CallSummaryTemplatesAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Call summary templates', href: '/settings/call-summary-templates' },
]

export default async function CallSummaryTemplatesSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Call summary templates" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">Restricted to Manager and above.</p>
        </PageBody>
      </>
    )
  }
  return (
    <>
      <PageHeader
        title="Call summary templates"
        subtitle="Prefill templates that appear as chips on the contact page Call Summary panel. Each can carry an attached PDF the caller opens mid-call."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <CallSummaryTemplatesAdmin />
      </PageBody>
    </>
  )
}
