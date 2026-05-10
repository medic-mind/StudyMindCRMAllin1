'use client'

import { signOut } from 'next-auth/react'

export function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: '/sign-in' })}
      className="rounded px-2 py-1.5 text-left text-neutral-700 hover:bg-neutral-100"
    >
      Sign out
    </button>
  )
}
