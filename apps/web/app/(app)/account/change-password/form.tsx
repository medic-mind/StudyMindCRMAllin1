'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { SessionProvider, useSession } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { trpc } from '@/lib/trpc/client'

const Schema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z
      .string()
      .min(12, 'At least 12 characters')
      .refine((v) => classCount(v) >= 3, 'Use at least 3 of: lowercase, uppercase, digit, symbol'),
    confirm: z.string().min(1, 'Confirm your new password'),
  })
  .refine((v) => v.newPassword === v.confirm, {
    message: 'New passwords do not match',
    path: ['confirm'],
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

// Scoped SessionProvider so the form can call useSession().update() after a
// successful change — this re-issues the session cookie with the fresh
// mustResetPassword=false, so the edge middleware stops bouncing the user back
// to this page (mirrors the setup-2fa wizard's fix for the same class of stale-
// cookie redirect). Scoped here only; the rest of the app reads the JWT
// server-side with no client session fetch.
export function ChangePasswordForm() {
  return (
    <SessionProvider>
      <ChangePasswordFormInner />
    </SessionProvider>
  )
}

function ChangePasswordFormInner() {
  const router = useRouter()
  const utils = trpc.useUtils()
  const { update: refreshSession } = useSession()
  const change = trpc.account.changePassword.useMutation({
    onSuccess: async () => {
      toast.success('Password updated. Other sessions have been signed out.')
      // Force the JWT to refresh NOW (trigger === 'update' in the jwt callback
      // re-reads mustResetPassword from the DB), so the edge cookie clears the
      // flag and the user is let into the CRM instead of being redirected back
      // here for up to ~60s.
      try {
        await refreshSession()
      } catch {
        // Non-fatal: the 60s role-refresh / next node request also converges it.
      }
      await utils.account.me.invalidate()
      router.push('/account')
      router.refresh()
    },
    onError: (err) => {
      toast.error(err.message ?? 'Could not change password')
    },
  })

  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  })

  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit((values) => {
        change.mutate({
          currentPassword: values.currentPassword,
          newPassword: values.newPassword,
        })
      })}
    >
      <div className="space-y-1.5">
        <Label htmlFor="currentPassword">Current password</Label>
        <Input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          {...register('currentPassword')}
        />
        {formState.errors.currentPassword && (
          <p className="text-xs text-red-600">{formState.errors.currentPassword.message}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          {...register('newPassword')}
        />
        {formState.errors.newPassword && (
          <p className="text-xs text-red-600">{formState.errors.newPassword.message}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input
          id="confirm"
          type="password"
          autoComplete="new-password"
          {...register('confirm')}
        />
        {formState.errors.confirm && (
          <p className="text-xs text-red-600">{formState.errors.confirm.message}</p>
        )}
      </div>
      <Button type="submit" disabled={change.isPending} className="w-full">
        {change.isPending ? 'Saving…' : 'Save new password'}
      </Button>
    </form>
  )
}
