// Email verification handler page. Reads the token from the query string,
// runs the server action, and redirects to /sign-in?verified=1 on success.
// On failure renders a friendly error and a "resend" form. ADR 0010.

import Link from 'next/link'
import { redirect } from 'next/navigation'

import { verifyEmail } from '@/lib/auth/server-actions'

import { ResendForm } from '../verify-email-sent/resend-form'

interface PageProps {
  searchParams: Promise<{ token?: string }>
}

export default async function VerifyPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const token = sp.token ?? ''
  const result = await verifyEmail(token)

  if (result.ok) {
    redirect('/sign-in?verified=1')
  }

  const reason = result.error === 'expired' ? 'This verification link has expired.' : 'This verification link is invalid.'

  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">Verification failed</h1>
      <p className="mb-6 text-sm text-neutral-600">{reason}</p>
      <ResendForm />
      <p className="mt-6 text-center text-xs text-neutral-600">
        <Link href="/sign-in" className="font-medium text-neutral-900 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
