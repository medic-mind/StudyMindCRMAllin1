'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { signIn } from 'next-auth/react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { PasswordField } from '@/components/ui/password-field'

const Schema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
})

type Values = z.infer<typeof Schema>

const ERROR_COPY: Record<string, string> = {
  INVALID_CREDENTIALS: 'Invalid email or password.',
  ACCOUNT_LOCKED: 'Account locked. Try again later.',
  EMAIL_NOT_VERIFIED: 'Email not verified — check your inbox.',
  CredentialsSignin: 'Invalid email or password.',
}

type Step = 'credentials' | 'totp'

export function SignInForm({
  callbackUrl,
  initialError,
}: {
  callbackUrl: string
  initialError: string | null
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(
    initialError ? ERROR_COPY[initialError] ?? 'Sign-in failed.' : null,
  )
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<Step>('credentials')
  // Stash the credentials between steps so the user does not retype them.
  const [stashed, setStashed] = useState<Values | null>(null)
  const [useRecovery, setUseRecovery] = useState(false)
  const [secondFactor, setSecondFactor] = useState('')

  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { email: '', password: '' },
  })

  async function attempt(values: Values, second: { totpCode?: string; recoveryCode?: string } = {}) {
    setBusy(true)
    setError(null)
    try {
      const res = await signIn('credentials', {
        email: values.email,
        password: values.password,
        ...second,
        redirect: false,
        callbackUrl,
      })
      if (!res) {
        setError('Sign-in failed. Try again.')
        return
      }
      if (res.error) {
        if (res.error === 'TOTP_REQUIRED') {
          // Move the user to the second step. Do not surface as an error.
          setStashed(values)
          setStep('totp')
          return
        }
        setError(ERROR_COPY[res.error] ?? 'Invalid email or password.')
        return
      }
      // Do NOT trust res.url — NextAuth builds it from AUTH_URL/NEXTAUTH_URL
      // which on a misconfigured Railway env points at http://localhost:3000.
      // Always navigate to our own callbackUrl (a path, not an origin).
      router.push(callbackUrl)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  if (step === 'totp' && stashed) {
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          const trimmed = secondFactor.trim()
          if (!trimmed) return
          attempt(stashed, useRecovery ? { recoveryCode: trimmed } : { totpCode: trimmed })
        }}
      >
        {error && (
          <div
            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
            role="alert"
            aria-live="polite"
          >
            {error}
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="second-factor">
            {useRecovery ? 'Recovery code' : 'Six-digit code from your Authenticator app'}
          </Label>
          <Input
            id="second-factor"
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            value={secondFactor}
            onChange={(e) => setSecondFactor(e.target.value)}
            autoFocus
          />
        </div>

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Verifying…' : 'Verify and sign in'}
        </Button>

        <div className="flex items-center justify-between text-xs text-neutral-600">
          <button
            type="button"
            className="hover:underline"
            onClick={() => {
              setUseRecovery((v) => !v)
              setSecondFactor('')
              setError(null)
            }}
          >
            {useRecovery
              ? 'Use a code from your Authenticator app'
              : 'Use a recovery code instead'}
          </button>
          <button
            type="button"
            className="hover:underline"
            onClick={() => {
              setStep('credentials')
              setSecondFactor('')
              setError(null)
            }}
          >
            Back
          </button>
        </div>
      </form>
    )
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit((values) => attempt(values))}>
      {error && (
        <div
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          role="alert"
          aria-live="polite"
        >
          {error}
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          {...register('email')}
        />
        {formState.errors.email && (
          <p className="text-xs text-red-600">{formState.errors.email.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="password">Password</Label>
          <Link href="/forgot" className="text-xs text-neutral-600 hover:underline">
            Forgot?
          </Link>
        </div>
        <PasswordField
          id="password"
          autoComplete="current-password"
          {...register('password')}
        />
        {formState.errors.password && (
          <p className="text-xs text-red-600">{formState.errors.password.message}</p>
        )}
      </div>

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}
