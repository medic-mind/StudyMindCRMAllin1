// Forgot-password page. Always returns the same generic response — no
// account enumeration. ADR 0010, CLAUDE.md §44.2.

import Link from 'next/link'

import { ForgotForm } from './form'

export default function ForgotPage() {
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">Reset your password</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Enter your email and we will send a password reset link.
      </p>
      <ForgotForm />
      <p className="mt-6 text-center text-xs text-neutral-600">
        <Link href="/sign-in" className="font-medium text-neutral-900 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  )
}
