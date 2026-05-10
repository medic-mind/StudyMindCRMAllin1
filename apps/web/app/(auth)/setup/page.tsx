// First-run setup page. Lets the seeded super_admin claim their account
// in the browser without touching env vars. Self-disables once any
// super_admin has a password. ADR 0010, CLAUDE.md §20.

import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'

import { readBootstrapStatus } from '@studymind/core/auth/bootstrap'
import { logger } from '@studymind/core/logger'

import { db } from '@/lib/db'

import { SetupForm } from './form'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface PageProps {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}

export default async function SetupPage({ searchParams }: PageProps) {
  const params = (await searchParams) ?? {}
  if (typeof params.done === 'string' && params.done === '1') {
    redirect('/sign-in?message=setup-complete')
  }

  // Wrap the DB read so a Prisma/schema/connection error is surfaced
  // inline instead of bubbling up to the global error boundary. In prod
  // Next.js strips error messages from the client and only shows the
  // digest, which is unhelpful for the operator trying to log in for
  // the first time. Showing the real message here is safe — the page is
  // already gated behind "no super_admin has a password yet".
  let state: Awaited<ReturnType<typeof readBootstrapStatus>>
  try {
    state = await readBootstrapStatus(db)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logger.error({ err }, 'auth.setup.read_bootstrap_failed')
    return (
      <div>
        <h1 className="mb-1 text-xl font-semibold text-neutral-900">
          Set up the first admin
        </h1>
        <p className="mb-4 text-sm text-neutral-600">
          Setup hit a server error reading the database. The full stack is
          in Sentry and the structured log (Axiom / Railway logs) under the
          tag <code className="font-mono text-xs">auth.setup.read_bootstrap_failed</code>.
        </p>
        <pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-red-200 bg-red-50 p-3 font-mono text-xs text-red-900">
          {message}
        </pre>
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

  // Hard gate: any super_admin with a password set means this surface is
  // closed. Returning notFound() is intentional — the page disappears
  // from the live site so the bootstrap can't be re-triggered.
  if (state.status === 'closed') {
    notFound()
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
