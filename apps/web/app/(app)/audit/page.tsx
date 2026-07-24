// Audit log — top-level nav section (CEO / Senior Manager / Manager —
// `audit.read`). The org-wide "who did what, and when" surface over the
// append-only AuditLogEntry table: every record view, edit, deletion, sign-in
// and export, searchable by type and date. Enforcement lives in the tRPC
// procedures (audit.list gates on `audit.read`); this page just hides itself
// from roles that cannot read it. CLAUDE.md §20, §27.

import { roleCan } from '@studymind/core/auth/policies'

import { getCurrentUser } from '@/lib/auth/server'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { AuditLogViewer } from './AuditLogViewer'

export const dynamic = 'force-dynamic'

const BREADCRUMBS = [{ label: 'Audit log', href: '/audit' }]

export default async function AuditLogPage() {
  const me = await getCurrentUser()
  if (!me || !roleCan(me.role, 'audit.read')) {
    return (
      <>
        <PageHeader title="Audit log" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to CEO, Senior Manager and Manager.
          </p>
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Who did what, and when — every record view, edit, deletion, sign-in and export"
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <AuditLogViewer />
      </PageBody>
    </>
  )
}
