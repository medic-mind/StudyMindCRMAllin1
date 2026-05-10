// Password reset page. Accepts a token in the URL, applies a new password,
// and auto signs the user in. ADR 0010.

import { ResetForm } from './form'

interface PageProps {
  searchParams: Promise<{ token?: string }>
}

export default async function ResetPage({ searchParams }: PageProps) {
  const sp = await searchParams
  const token = sp.token ?? ''
  return (
    <div>
      <h1 className="mb-1 text-xl font-semibold text-neutral-900">Choose a new password</h1>
      <p className="mb-6 text-sm text-neutral-600">
        Pick a password you have not used here before. At least 12 characters.
      </p>
      <ResetForm token={token} />
    </div>
  )
}
