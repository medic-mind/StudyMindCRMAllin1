// First-run setup page. Lets the seeded super_admin claim their account
// in the browser without touching env vars. Self-disables once any
// super_admin has a password. ADR 0010, CLAUDE.md §20.

import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { readBootstrapStatus } from '@studymind/core/auth/bootstrap'

import { db } from '@/lib/db'

import { SetupForm } from './form'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export default async function SetupPage({ searchParams }: PageProps) {
  const state = await readBootstrapStatus(db)

  // Hard gate: any super_admin with a password set means this surface is
  // closed. Returning notFound() is intentional — the page disappears
  // from the live site so the bootstrap can't be re-triggered.
  if (state.status === 'closed') {
    notFound()
  }

  const params = (await searchParams) ?? {}
  if (typeof params.done === 'string' && params.done === '1') {
    redirect('/sign-in?message=setup-complete')
  }

  if (state.status === 'no_user') {
    return (
      <div>
        <h1 className="mb-1 text-xl font-semibold text-neutral-900">
          Set up the first admin
        </h1>
        <p className="text-sm text-neutral-600">
          No super admin user has been seeded yet. Run{' '}
          <code className="font-mono text-xs">
            pnpm tsx packages/db/prisma/seed-super-admin.ts
          </code>{' '}
          first, then reload this page.
        </p>
        <p className="mt-6 text-center text-xs text-neutral-600">
          <Link
            href="/sign-in"
            className="font-medium text-neutral-900 hover:underline"
          >
            Back to sign in
          </Link>
        </p>
      </div>
    )
  }

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">
        Set up the first admin
      </h1>
      <p className="mb-6 text-sm text-neutral-600">
        Welcome. Pick a password for{' '}
        <span className="font-mono text-neutral-800">
          {state.candidateEmail}
        </span>{' '}
        to finish setup. This page disappears once you sign in.
      </p>
      <SetupForm presetEmail={state.candidateEmail} />
      <p className="mt-6 text-center text-xs text-neutral-600">
        Already set up?{' '}
        <Link
          href="/sign-in"
          className="font-medium text-neutral-900 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </div>
  )
}
