// Sent-confirmation page after sign-up. Includes a "resend" form for
// convenience. ADR 0010.

import Link from 'next/link'

import { ResendForm } from './resend-form'

export default function VerifyEmailSentPage() {
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">Check your email</h1>
      <p className="mb-6 text-sm text-neutral-600">
        We have sent a verification link to your email. The link is valid for 24 hours.
      </p>
      <ResendForm />
      <p className="mt-6 text-center text-xs text-neutral-600">
        <Link href="/sign-in" className="font-medium text-neutral-900 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
