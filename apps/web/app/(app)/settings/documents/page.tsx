// Settings → Documents (Manager+). The info pack / brochure PDF library the
// team attaches to call-summary emails. CLAUDE.md §20.1.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { InfoPacksAdmin } from './InfoPacksAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager', 'manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Documents', href: '/settings/documents' },
]

export default async function DocumentsSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Documents" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">Restricted to Manager and above.</p>
        </PageBody>
      </>
    )
  }
  return (
    <>
      <PageHeader
        title="Documents"
        subtitle="Information packs and brochures (PDF) the team attaches to call-summary emails. Agents pick from this library at send time — Trengo WhatsApp templates already carry their own pack links, so these only ride the email channel."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <InfoPacksAdmin />
      </PageBody>
    </>
  )
}
