// /account landing page. Shows the current user's identity and links to the
// change-password and sessions pages. ADR 0010, chunk 7.

import Link from 'next/link'
import { redirect } from 'next/navigation'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

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
      <section className="rounded-md border border-neutral-200 bg-white p-4 shadow-sm">
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <dt className="text-neutral-500">Name</dt>
          <dd className="col-span-2 text-neutral-900">{me.name ?? '—'}</dd>
          <dt className="text-neutral-500">Email</dt>
          <dd className="col-span-2 text-neutral-900">{me.email}</dd>
          <dt className="text-neutral-500">Last sign-in</dt>
          <dd className="col-span-2 text-neutral-900">{fmt(me.lastSignInAt)}</dd>
        </dl>
      </section>

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
