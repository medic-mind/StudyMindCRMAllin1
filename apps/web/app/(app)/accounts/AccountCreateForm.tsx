// Inline create form for B2B accounts. Lean — just the fields needed to
// stub a record (name + optional address + email + status). Full editing
// happens on the detail page.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

type Kind = 'school' | 'partnership'
type Status = 'prospect' | 'active' | 'paused' | 'churned'

interface Props {
  kind: Kind
  onClose: () => void
  onCreated: (id: string) => void
}

export function AccountCreateForm({ kind, onClose, onCreated }: Props) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [status, setStatus] = useState<Status>('prospect')
  const [contactEmail, setContactEmail] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [website, setWebsite] = useState('')
  const [city, setCity] = useState('')
  const [country, setCountry] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  const create = trpc.businessAccount.create.useMutation()

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) {
      toast.error('Name is required')
      return
    }
    setBusy(true)
    try {
      const result = await create.mutateAsync({
        kind,
        name: name.trim(),
        status,
        contactEmail: contactEmail.trim() || undefined,
        contactPhone: contactPhone.trim() || undefined,
        website: website.trim() || undefined,
        city: city.trim() || undefined,
        country: country.trim() || undefined,
        description: description.trim() || undefined,
      })
      toast.success(`${kind === 'school' ? 'School' : 'Partnership'} created`)
      onCreated(result.id)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/30 p-4 shadow-card"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">
          New {kind === 'school' ? 'school' : 'partnership'}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="prospect">Prospect</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="churned">Churned</option>
          </Select>
        </Field>
        <Field label="Org email">
          <Input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="info@example.com"
          />
        </Field>
        <Field label="Org phone">
          <Input
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="+44 …"
          />
        </Field>
        <Field label="Website">
          <Input
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://"
          />
        </Field>
        <Field label="City">
          <Input value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Country">
          <Input value={country} onChange={(e) => setCountry(e.target.value)} />
        </Field>
      </div>

      <Field label="Description (optional)">
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
        {required ? <span className="text-red-600"> *</span> : null}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
