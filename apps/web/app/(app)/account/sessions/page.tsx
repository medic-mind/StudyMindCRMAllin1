// /account/sessions page. Lists active Session rows for the current user
// and provides revoke actions. ADR 0010, chunk 7.

import { SessionsList } from './list'

export const dynamic = 'force-dynamic'

export default function SessionsPage() {
  return (
    <div className="max-w-3xl space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">Active sessions</h1>
        <p className="text-sm text-neutral-600">
          Each row is a device or browser signed in to your account. Revoking a session forces it
          to sign in again.
        </p>
      </header>
      <SessionsList />
    </div>
  )
}
