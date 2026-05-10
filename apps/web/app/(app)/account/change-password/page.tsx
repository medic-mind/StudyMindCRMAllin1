// /account/change-password page. Reachable while the user holds the
// mustResetPassword flag (the middleware funnels them here). ADR 0010,
// chunk 7.

import { ChangePasswordForm } from './form'

export const dynamic = 'force-dynamic'

export default function ChangePasswordPage() {
  return (
    <div className="max-w-md space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">Change password</h1>
        <p className="text-sm text-neutral-600">
          Pick a password you have not used here before. At least 12 characters.
        </p>
      </header>
      <ChangePasswordForm />
    </div>
  )
}
