'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { signUp } from '@/lib/auth/server-actions'

const Schema = z.object({
  name: z.string().trim().min(1, 'Enter your name'),
  email: z.string().email('Enter a valid email'),
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    .refine((v) => passwordClassCount(v) >= 3, {
      message: 'Use at least 3 of: lowercase, uppercase, digit, symbol',
    }),
})

type Values = z.infer<typeof Schema>

function passwordClassCount(p: string): number {
  let n = 0
  if (/[a-z]/.test(p)) n += 1
  if (/[A-Z]/.test(p)) n += 1
  if (/[0-9]/.test(p)) n += 1
  if (/[^A-Za-z0-9]/.test(p)) n += 1
  return n
}

function strengthLabel(p: string): { label: string; tone: string } {
  if (!p) return { label: '', tone: '' }
  if (p.length < 12) return { label: 'Too short', tone: 'text-red-600' }
  const classes = passwordClassCount(p)
  if (classes < 3) return { label: 'Weak', tone: 'text-amber-600' }
  if (classes === 3) return { label: 'Good', tone: 'text-green-700' }
  return { label: 'Strong', tone: 'text-green-700' }
}

export function SignUpForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const { register, handleSubmit, watch, formState } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { name: '', email: '', password: '' },
  })

  const password = watch('password') ?? ''
  const strength = strengthLabel(password)

  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit(async (values) => {
        setBusy(true)
        setError(null)
        try {
          const res = await signUp(values)
          if (!res.ok) {
            setError(res.error)
            return
          }
          router.push('/verify-email-sent')
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
        <Label htmlFor="name">Display name</Label>
        <Input id="name" autoComplete="name" {...register('name')} />
        {formState.errors.name && (
          <p className="text-xs text-red-600">{formState.errors.name.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="email" {...register('email')} />
        {formState.errors.email && (
          <p className="text-xs text-red-600">{formState.errors.email.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          aria-describedby="password-strength"
          {...register('password')}
        />
        <p id="password-strength" className={`text-xs ${strength.tone}`}>
          {strength.label || 'Use at least 12 characters with mixed character classes.'}
        </p>
        {formState.errors.password && (
          <p className="text-xs text-red-600">{formState.errors.password.message}</p>
        )}
      </div>

      <Button type="submit" disabled={busy} className="w-full">
        {busy ? 'Creating account…' : 'Create account'}
      </Button>

      <p className="text-center text-xs text-neutral-600">
        Already have an account?{' '}
        <Link href="/sign-in" className="font-medium text-neutral-900 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  )
}
