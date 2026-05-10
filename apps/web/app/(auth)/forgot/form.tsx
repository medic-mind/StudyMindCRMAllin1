'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { requestPasswordReset } from '@/lib/auth/server-actions'

export function ForgotForm() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setMessage(null)
        try {
          const res = await requestPasswordReset(email)
          // Always show the same message regardless of result.
          setMessage(
            (res.ok && res.message) ||
              'If that account exists, a password reset link has been sent.',
          )
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {message && (
        <div
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
          role="status"
          aria-live="polite"
        >
          {message}
        </div>
      )}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  )
}
