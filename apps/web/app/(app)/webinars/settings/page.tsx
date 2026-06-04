// Webinar settings: the default email template (Zoom link + PDF schedule),
// send timing, Zoom rotation interval, and the sending mailbox.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { SettingsForm } from './SettingsForm'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function WebinarSettingsPage() {
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const settings = await caller.webinar.settings.get()

  return (
    <>
      <PageHeader
        title="Webinar settings"
        subtitle="The weekly email template and defaults. Per-class overrides win where set."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Settings', href: '/webinars/settings' },
        ]}
      />
      <PageBody>
        <SettingsForm initial={settings} canManage={MANAGE.has(me?.role ?? '')} />
      </PageBody>
    </>
  )
}
