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

  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { email: '', password: '' },
  })

  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit(async (values) => {
        setBusy(true)
        setError(null)
        try {
          const res = await signIn('credentials', {
            email: values.email,
            password: values.password,
            redirect: false,
            callbackUrl,
          })
          if (!res) {
            setError('Sign-in failed. Try again.')
            return
          }
          if (res.error) {
            setError(ERROR_COPY[res.error] ?? 'Invalid email or password.')
            return
          }
          router.push(res.url ?? callbackUrl)
          router.refresh()
        } finally {
          setBusy(false)
        }
      })}
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
        <Input
          id="password"
          type="password"
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

      <p className="text-center text-xs text-neutral-600">
        New here?{' '}
        <Link href="/sign-up" className="font-medium text-neutral-900 hover:underline">
          Create an account
        </Link>
      </p>
    </form>
  )
}
