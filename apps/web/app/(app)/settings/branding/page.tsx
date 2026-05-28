// Settings → Branding (CLAUDE.md §4, §20). CEO and Senior Manager only.
// Upload a custom logo (stored in Postgres); the shell + sign-in screen pick
// it up. The branding.setLogo / removeLogo procedures enforce the same gate.

import { getBrandingLogoMeta } from '@studymind/core/branding'

import { getCurrentUser } from '@/lib/auth/server'
import { db } from '@/lib/db'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'

import { BrandingLogoForm } from './BrandingLogoForm'

export const dynamic = 'force-dynamic'

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Branding', href: '/settings/branding' },
]

const MANAGE_ROLES = new Set(['ceo', 'senior_manager'])

export default async function BrandingSettingsPage() {
  const me = await getCurrentUser()
  if (!me || !MANAGE_ROLES.has(me.role)) {
    return (
      <>
        <PageHeader title="Branding" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to CEO and Senior Manager.
          </p>
        </PageBody>
      </>
    )
  }

  const meta = await getBrandingLogoMeta(db)

  return (
    <>
      <PageHeader
        title="Branding"
        subtitle="Upload the logo shown across the CRM"
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <BrandingLogoForm initialHasLogo={meta.hasLogo} initialVersion={meta.version} />
      </PageBody>
    </>
  )
}
