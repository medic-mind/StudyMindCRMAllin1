'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { acceptInvite } from '@/lib/auth/server-actions'

const Schema = z.object({
  password: z
    .string()
    .min(12, 'At least 12 characters')
    .refine((v) => classCount(v) >= 3, 'Use at least 3 of: lowercase, uppercase, digit, symbol'),
})

type Values = z.infer<typeof Schema>

function classCount(p: string): number {
  let n = 0
  if (/[a-z]/.test(p)) n += 1
  if (/[A-Z]/.test(p)) n += 1
  if (/[0-9]/.test(p)) n += 1
  if (/[^A-Za-z0-9]/.test(p)) n += 1
  return n
}

export function AcceptInviteForm({ token, email }: { token: string; email: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(token ? null : 'Invite token is missing.')
  const [busy, setBusy] = useState(false)

  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { password: '' },
  })

  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit(async (values) => {
        setBusy(true)
        setError(null)
        try {
          const res = await acceptInvite({ token, password: values.password })
          if (!res.ok) {
            setError(res.error)
            return
          }
          const r = await signIn('credentials', {
            email: res.email,
            password: values.password,
            redirect: false,
            callbackUrl: '/inbox',
          })
          if (r && !r.error) {
            // Use our own path — NextAuth's url honours AUTH_URL which on
            // a misconfigured env points at localhost.
            router.push('/inbox')
            router.refresh()
            return
          }
          router.push('/sign-in?invited=1')
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
      {email && (
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" value={email} readOnly disabled />
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="password">Choose a password</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
        />
        {formState.errors.password && (
          <p className="text-xs text-red-600">{formState.errors.password.message}</p>
        )}
      </div>
      <Button type="submit" disabled={busy || !token} className="w-full">
        {busy ? 'Saving…' : 'Accept invite'}
      </Button>
    </form>
  )
}
