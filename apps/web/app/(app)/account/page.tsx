// /account landing page. Shows the current user's identity and links to the
// change-password and sessions pages. ADR 0010, chunk 7.

import Link from 'next/link'
import { redirect } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { createServerCaller } from '@/lib/trpc/server'

import { AvatarSection } from './AvatarSection'
import { ProfileForm } from './ProfileForm'

const BREADCRUMBS = [{ label: 'Account', href: '/account' }]

export const dynamic = 'force-dynamic'
export const revalidate = 0

function fmt(d: Date | null | undefined): string {
  if (!d) return 'Never'
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d)
}

export default async function AccountPage() {
  const trpc = await createServerCaller()
  let me
  try {
    me = await trpc.account.me()
  } catch {
    redirect('/sign-in')
  }
  return (
    <>
      <PageHeader
        title="My account"
        subtitle="Manage your StudyMind CRM sign-in."
        breadcrumbs={BREADCRUMBS}
      />
      <PageBody>
        <div className="max-w-2xl space-y-6">
      <Card className="p-4">
        <ProfileForm initialName={me.name ?? null} initialEmail={me.email} />
        <p className="mt-4 border-t border-neutral-100 pt-3 text-xs text-neutral-500">
          Last sign-in: {fmt(me.lastSignInAt)}
        </p>
      </Card>

      <Card className="p-4">
        <AvatarSection
          name={me.name ?? null}
          email={me.email}
          initialAvatarKey={me.avatarKey ?? null}
        />
      </Card>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-neutral-900">Security</h2>
        <ul className="list-none space-y-1 text-sm">
          <li>
            <Link href="/account/change-password" className="text-neutral-900 hover:underline">
              Change password
            </Link>
          </li>
          <li>
            <Link href="/account/sessions" className="text-neutral-900 hover:underline">
              Active sessions
            </Link>
          </li>
          <li>
            {me.totpEnabledAt ? (
              <Link href="/account/disable-2fa" className="text-neutral-900 hover:underline">
                Disable two-factor authentication
              </Link>
            ) : (
              <Link href="/account/setup-2fa" className="text-neutral-900 hover:underline">
                Set up two-factor authentication
              </Link>
            )}
          </li>
        </ul>
        <p className="text-xs text-neutral-500">
          Two-factor:{' '}
          {me.totpEnabledAt ? `Enabled (${fmt(me.totpEnabledAt)})` : 'Not enabled'}
        </p>
      </section>
        </div>
      </PageBody>
    </>
  )
}
