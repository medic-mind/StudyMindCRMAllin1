'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { resendVerification } from '@/lib/auth/server-actions'

export function ResendForm() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        setMessage(null)
        setError(null)
        try {
          const res = await resendVerification(email)
          if (res.ok) setMessage(res.message ?? 'If that account exists, a new link has been sent.')
          else setError(res.error)
        } finally {
          setBusy(false)
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="email">Resend the verification email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      {message && (
        <p className="text-sm text-green-700" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" variant="secondary" disabled={busy} className="w-full">
        {busy ? 'Sending…' : 'Resend verification email'}
      </Button>
    </form>
  )
}
