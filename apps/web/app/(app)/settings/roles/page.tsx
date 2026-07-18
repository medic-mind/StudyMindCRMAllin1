// Settings → Roles & permissions (CEO + Senior Manager). Create custom roles
// (additive permission bundles), assign them to users, and view the built-in
// role matrix. Enforcement lives in the tRPC procedures + `sanitizeRolePermissions`
// (§20). Built-in roles are immutable and shown read-only.

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { RolesAdmin } from './RolesAdmin'

export const dynamic = 'force-dynamic'

const MANAGE_ROLES = new Set(['ceo', 'senior_manager'])

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Roles & permissions', href: '/settings/roles' },
]

export default async function RolesSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Roles & permissions" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to CEO and Senior Manager.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Roles & permissions"
        subtitle="Create custom roles and assign permissions on top of the built-in roles"
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <RolesAdmin />
      </PageBody>
    </>
  )
}
