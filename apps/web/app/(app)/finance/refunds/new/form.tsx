'use client'

// Issue-refund client form. CLAUDE.md §8 — refunds carry an idempotency
// key derived from (chargeId, reasonCode); the server enforces, the form
// just collects intent and shows a confirmation step.

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'
import { z } from 'zod'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { trpc } from '@/lib/trpc/client'

const REASONS = [
  'duplicate',
  'fraudulent',
  'requested_by_customer',
  'customer_dissatisfied',
  'service_not_delivered',
  'other',
] as const

const Schema = z.object({
  chargeId: z.string().trim().min(3, 'Enter the Stripe charge id'),
  reasonCode: z.enum(REASONS),
  amountGbp: z
    .string()
    .trim()
    .refine(
      (v) => v === '' || /^\d+(\.\d{1,2})?$/.test(v),
      'Enter a number with up to two decimal places',
    ),
})

type Values = z.infer<typeof Schema>

function gbpToMinor(v: string): number | undefined {
  if (!v) return undefined
  const cents = Math.round(Number(v) * 100)
  return Number.isFinite(cents) && cents > 0 ? cents : undefined
}

export function IssueRefundForm() {
  const router = useRouter()
  const [confirming, setConfirming] = useState<Values | null>(null)

  const create = trpc.finance.refund.create.useMutation({
    onSuccess: (res) => {
      toast.success(`Refund queued (${res.status}).`)
      router.push('/finance/refunds')
      router.refresh()
    },
    onError: (e) => {
      toast.error(e.message ?? 'Refund failed. Check Sentry for the request id.')
    },
  })

  const { register, handleSubmit, formState, getValues } = useForm<Values>({
    resolver: zodResolver(Schema),
    defaultValues: { chargeId: '', reasonCode: 'requested_by_customer', amountGbp: '' },
  })

  if (confirming) {
    const minor = gbpToMinor(confirming.amountGbp)
    return (
      <div className="space-y-4">
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="font-semibold">Confirm refund</div>
          <ul className="mt-2 space-y-1">
            <li>
              Charge: <code className="font-mono">{confirming.chargeId}</code>
            </li>
            <li>Reason: {confirming.reasonCode}</li>
            <li>
              Amount:{' '}
              {minor
                ? new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(
                    minor / 100,
                  )
                : 'full charge'}
            </li>
          </ul>
        </div>
        <div className="flex gap-2">
          <Button
            variant="destructive"
            disabled={create.isPending}
            onClick={() =>
              create.mutate({
                chargeId: confirming.chargeId,
                reasonCode: confirming.reasonCode,
                amountMinor: gbpToMinor(confirming.amountGbp),
              })
            }
          >
            {create.isPending ? 'Issuing…' : 'Issue refund'}
          </Button>
          <Button
            variant="secondary"
            onClick={() => setConfirming(null)}
            disabled={create.isPending}
          >
            Back
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit(() => setConfirming(getValues()))}
    >
      <div className="space-y-1.5">
        <Label htmlFor="chargeId">Stripe charge id</Label>
        <Input id="chargeId" placeholder="ch_..." {...register('chargeId')} />
        {formState.errors.chargeId && (
          <p className="text-xs text-red-600">{formState.errors.chargeId.message}</p>
        )}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="reasonCode">Reason</Label>
        <select
          id="reasonCode"
          className="h-9 w-full rounded-md border border-neutral-300 bg-white px-2 text-sm"
          {...register('reasonCode')}
        >
          {REASONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="amountGbp">Amount (GBP, optional)</Label>
        <Input
          id="amountGbp"
          inputMode="decimal"
          placeholder="Leave blank for a full refund"
          {...register('amountGbp')}
        />
        {formState.errors.amountGbp && (
          <p className="text-xs text-red-600">{formState.errors.amountGbp.message}</p>
        )}
      </div>
      <Button type="submit" className="w-full">
        Review
      </Button>
    </form>
  )
}
