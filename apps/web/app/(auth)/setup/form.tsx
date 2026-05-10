'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { claimInitialAdmin } from '@/lib/auth/server-actions'

interface Props {
  presetEmail: string
}

const MIN_PASSWORD_LENGTH = 12

export function SetupForm({ presetEmail }: Props) {
  const router = useRouter()
  const [email, setEmail] = useState(presetEmail)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault()
        setError(null)
        if (password.length < MIN_PASSWORD_LENGTH) {
          setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
          return
        }
        if (password !== confirm) {
          setError('Passwords do not match.')
          return
        }
        setBusy(true)
        try {
          const res = await claimInitialAdmin({ email, password })
          if (!res.ok) {
            setError(res.error)
            return
          }
          router.replace('/sign-in?message=setup-complete')
          router.refresh()
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
      <div className="space-y-1.5">
        <Label htmlFor="password">New password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-neutral-500">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm password</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
      {error && (
        <div
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
          aria-live="polite"
        >
          {error}
        </div>
      )}
      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Setting up…' : 'Finish setup'}
      </Button>
    </form>
  )
}
