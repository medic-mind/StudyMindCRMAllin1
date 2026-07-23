// Additional points of contact for a Contact — extra emails, phone numbers and
// other handles beyond the primary email/phone. The primary values are shown
// (read-only, edited via the contact's Edit form, since they're the matching
// source of truth); everything else is added / edited / removed here via
// `contact.points.*`. CLAUDE.md §26 — client island; the tRPC layer audits.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { AtSignIcon, MailIcon, PhoneIcon, PlusIcon, XIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

type Kind = 'email' | 'phone' | 'other'

interface Props {
  contactId: string
  primaryEmail: string | null
  primaryPhone: string | null
  canWrite: boolean
}

function kindIcon(kind: Kind) {
  if (kind === 'email') return <MailIcon size={14} className="text-neutral-400" />
  if (kind === 'phone') return <PhoneIcon size={14} className="text-neutral-400" />
  return <AtSignIcon size={14} className="text-neutral-400" />
}

function pointHref(kind: Kind, value: string): string | null {
  if (kind === 'email') return `mailto:${value}`
  if (kind === 'phone') return `tel:${value}`
  return null
}

export function PointsOfContactSection({
  contactId,
  primaryEmail,
  primaryPhone,
  canWrite,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const pointsQuery = trpc.contact.points.list.useQuery({ contactId })

  const refresh = async () => {
    await utils.contact.points.list.invalidate({ contactId })
    router.refresh()
  }

  const [kind, setKind] = useState<Kind>('phone')
  const [value, setValue] = useState('')
  const [label, setLabel] = useState('')

  const add = trpc.contact.points.add.useMutation({
    onSuccess: async () => {
      setValue('')
      setLabel('')
      await refresh()
      toast.success('Point of contact added')
    },
    onError: (e) => toast.error(e.message ?? 'Could not add'),
  })
  const remove = trpc.contact.points.remove.useMutation({
    onSuccess: refresh,
    onError: (e) => toast.error(e.message ?? 'Could not remove'),
  })

  function submit() {
    const v = value.trim()
    if (!v) {
      toast.error('Enter a value')
      return
    }
    add.mutate({ contactId, kind, value: v, label: label.trim() || undefined })
  }

  const points = pointsQuery.data ?? []
  const hasPrimary = Boolean(primaryEmail || primaryPhone)

  return (
    <div className="space-y-4 text-sm">
      {/* Primary — the matching values, edited on the contact's Edit form. */}
      {hasPrimary ? (
        <div className="space-y-1.5">
          {primaryEmail ? (
            <PrimaryRow kind="email" value={primaryEmail} />
          ) : null}
          {primaryPhone ? (
            <PrimaryRow kind="phone" value={primaryPhone} />
          ) : null}
        </div>
      ) : (
        <p className="text-neutral-500">No primary email or phone yet — add one via Edit.</p>
      )}

      {/* Additional points */}
      {points.length > 0 ? (
        <ul className="space-y-1.5">
          {points.map((p) => {
            const href = pointHref(p.kind, p.value)
            return (
              <li
                key={p.id}
                className="flex items-center gap-2 rounded-md border border-neutral-200 bg-white px-2.5 py-1.5"
              >
                {kindIcon(p.kind)}
                <div className="min-w-0 flex-1">
                  {href ? (
                    <a href={href} className="break-all font-medium text-primary-700 hover:underline">
                      {p.value}
                    </a>
                  ) : (
                    <span className="break-all font-medium text-neutral-800">{p.value}</span>
                  )}
                  {p.label ? <span className="ml-1.5 text-xs text-neutral-500">· {p.label}</span> : null}
                </div>
                {canWrite ? (
                  <button
                    type="button"
                    onClick={() => remove.mutate({ id: p.id })}
                    disabled={remove.isPending}
                    aria-label={`Remove ${p.value}`}
                    className="rounded p-1 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
                  >
                    <XIcon size={14} />
                  </button>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      {/* Add form */}
      {canWrite ? (
        <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/60 p-3">
          <div className="grid gap-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <Field label="Type">
              <Select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as Kind)
                  setValue('')
                }}
              >
                <option value="phone">Phone</option>
                <option value="email">Email</option>
                <option value="other">Other</option>
              </Select>
            </Field>
            <Field label={kind === 'other' ? 'Value (e.g. WhatsApp, Instagram)' : 'Value'}>
              {kind === 'phone' ? (
                <PhoneInput value={value} onChange={setValue} />
              ) : (
                <Input
                  type={kind === 'email' ? 'email' : 'text'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder={kind === 'email' ? 'name@example.com' : 'e.g. WhatsApp: 07…'}
                />
              )}
            </Field>
          </div>
          <div className="mt-2 flex items-end gap-2">
            <Field label="Label (optional)" className="flex-1">
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={120}
                placeholder="e.g. Mum's mobile, Work email"
              />
            </Field>
            <Button type="button" size="sm" disabled={add.isPending} onClick={submit}>
              <PlusIcon size={15} className="-ml-0.5 mr-1" />
              {add.isPending ? 'Adding…' : 'Add'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PrimaryRow({ kind, value }: { kind: 'email' | 'phone'; value: string }) {
  const href = kind === 'email' ? `mailto:${value}` : `tel:${value}`
  return (
    <div className="flex items-center gap-2 rounded-md bg-neutral-50 px-2.5 py-1.5">
      {kind === 'email' ? (
        <MailIcon size={14} className="text-neutral-400" />
      ) : (
        <PhoneIcon size={14} className="text-neutral-400" />
      )}
      <a href={href} className="break-all font-medium text-primary-700 hover:underline">
        {value}
      </a>
      <span className="ml-auto rounded-full bg-primary-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-700">
        Primary
      </span>
    </div>
  )
}
