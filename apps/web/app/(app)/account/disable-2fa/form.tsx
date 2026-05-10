'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc/client'

const Schema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  totpCode: z
    .string()
    .min(6, 'Enter the 6-digit code')
    .max(6, 'Enter the 6-digit code')
    .regex(/^\d{6}$/, 'Six digits only'),
})

type Values = z.infer<typeof Schema>

export function Disable2faForm() {
  const router = useRouter()
  const utils = trpc.useUtils()
  const disable = trpc.account.totp.disable.useMutation({
    onSuccess: () => {
      toast.success('Two-factor disabled.')
      utils.account.me.invalidate()
      router.push('/account')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not disable two-factor.'),
  })

  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { currentPassword: '', totpCode: '' },
  })

  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit((values) => disable.mutate(values))}
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
        <Label htmlFor="totpCode">6-digit code</Label>
        <Input
          id="totpCode"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          {...register('totpCode')}
        />
        {formState.errors.totpCode && (
          <p className="text-xs text-red-600">{formState.errors.totpCode.message}</p>
        )}
      </div>
      <Button type="submit" disabled={disable.isPending} className="w-full">
        {disable.isPending ? 'Disabling…' : 'Disable two-factor'}
      </Button>
    </form>
  )
}
