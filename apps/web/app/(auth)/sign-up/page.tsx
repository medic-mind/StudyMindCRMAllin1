// Sign-up page. Creates a User row with `emailVerifiedAt = null`, issues an
// email verification token and sends the link via Resend. ADR 0010.

import { SignUpForm } from './form'

export default function SignUpPage() {
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">Create your account</h1>
      <p className="mb-6 text-sm text-neutral-600">
        StudyMind staff only. We will email you a verification link.
      </p>
      <SignUpForm />
    </div>
  )
}
