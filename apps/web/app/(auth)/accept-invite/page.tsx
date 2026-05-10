// Accept-invite page. Admin invites a user via admin.users.invite which
// emails them a link here. The user picks a password; we verify the token,
// set the password, mark the email verified, and sign them in. ADR 0010.

import { AcceptInviteForm } from './form'

interface PageProps {
  searchParams: Promise<{ token?: string; email?: string }>
}

export default async function AcceptInvitePage({ searchParams }: PageProps) {
  const sp = await searchParams
  const token = sp.token ?? ''
  const email = sp.email ?? ''
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">Set your password</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Welcome to StudyMind CRM. Choose a password to finish creating your account.
      </p>
      <AcceptInviteForm token={token} email={email} />
    </div>
  )
}
