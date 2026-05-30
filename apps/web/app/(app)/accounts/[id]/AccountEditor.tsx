// Editable detail panel for a B2B account. All fields editable; Save sends
// only the changed fields. Manager+ writes (server enforces too).

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { CountrySelect } from '@/components/ui/country-select'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

type Status = 'prospect' | 'active' | 'paused' | 'churned'

interface Account {
  id: string
  kind: 'school' | 'partnership'
  name: string
  status: Status
  description: string | null
  contactEmail: string | null
  contactPhone: string | null
  website: string | null
  addressLine1: string | null
  addressLine2: string | null
  city: string | null
  postcode: string | null
  country: string | null
  notes: string | null
  archived: boolean
  companies: ReadonlyArray<{
    id: string
    name: string
    slug: string
    color: string | null
  }>
}

export function AccountEditor({ account }: { account: Account }) {
  const router = useRouter()
  const [name, setName] = useState(account.name)
  const [status, setStatus] = useState<Status>(account.status)
  const [description, setDescription] = useState(account.description ?? '')
  const [contactEmail, setContactEmail] = useState(account.contactEmail ?? '')
  const [contactPhone, setContactPhone] = useState(account.contactPhone ?? '')
  const [website, setWebsite] = useState(account.website ?? '')
  const [addressLine1, setAddressLine1] = useState(account.addressLine1 ?? '')
  const [addressLine2, setAddressLine2] = useState(account.addressLine2 ?? '')
  const [city, setCity] = useState(account.city ?? '')
  const [postcode, setPostcode] = useState(account.postcode ?? '')
  const [country, setCountry] = useState(account.country ?? '')
  const [notes, setNotes] = useState(account.notes ?? '')
  const [companyIds, setCompanyIds] = useState<string[]>(
    account.companies.map((c) => c.id),
  )
  const [busy, setBusy] = useState(false)

  const companiesList = trpc.company.pickList.useQuery()
  const update = trpc.businessAccount.update.useMutation()
  const setCompanies = trpc.businessAccount.companies.set.useMutation()
  const archive = trpc.businessAccount.archive.useMutation()
  const restore = trpc.businessAccount.restore.useMutation()

  async function save() {
    setBusy(true)
    try {
      await update.mutateAsync({
        id: account.id,
        name: name.trim(),
        status,
        description: description.trim() || null,
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
        website: website.trim() || null,
        addressLine1: addressLine1.trim() || null,
        addressLine2: addressLine2.trim() || null,
        city: city.trim() || null,
        postcode: postcode.trim() || null,
        country: country.trim() || null,
        notes: notes.trim() || null,
      })
      await setCompanies.mutateAsync({
        accountId: account.id,
        companyIds,
      })
      toast.success('Saved')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  async function toggleArchive() {
    setBusy(true)
    try {
      if (account.archived) {
        await restore.mutateAsync({ id: account.id })
        toast.success('Restored')
      } else {
        await archive.mutateAsync({ id: account.id })
        toast.success('Archived')
      }
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
      <h2 className="text-sm font-semibold text-neutral-900">Details</h2>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
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
          />
        </Field>
        <Field label="Org phone">
          <Input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
        </Field>
        <Field label="Website" wide>
          <Input
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://"
          />
        </Field>
      </div>

      <Field label="Description">
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <Field label="Companies (sister-brand tags)">
        <div className="flex flex-wrap gap-1.5">
          {(companiesList.data ?? []).map((c) => {
            const picked = companyIds.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                onClick={() =>
                  setCompanyIds((prev) =>
                    picked ? prev.filter((id) => id !== c.id) : [...prev, c.id],
                  )
                }
                className={
                  picked
                    ? 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white'
                    : 'inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50'
                }
                style={picked ? { backgroundColor: c.color ?? '#475569' } : undefined}
              >
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: c.color ?? '#94a3b8' }}
                />
                {c.name}
              </button>
            )
          })}
          {(companiesList.data ?? []).length === 0 && (
            <span className="text-xs text-neutral-500">
              No companies yet — add them in Settings → Companies.
            </span>
          )}
        </div>
      </Field>

      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Address
      </h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Line 1" wide>
          <Input value={addressLine1} onChange={(e) => setAddressLine1(e.target.value)} />
        </Field>
        <Field label="Line 2" wide>
          <Input value={addressLine2} onChange={(e) => setAddressLine2(e.target.value)} />
        </Field>
        <Field label="City">
          <Input value={city} onChange={(e) => setCity(e.target.value)} />
        </Field>
        <Field label="Postcode">
          <Input value={postcode} onChange={(e) => setPostcode(e.target.value)} />
        </Field>
        <Field label="Country">
          <CountrySelect value={country} onChange={setCountry} />
        </Field>
      </div>

      <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Notes
      </h3>
      <Textarea
        rows={6}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Account history, key decisions, next steps…"
      />

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <Button type="button" onClick={save} disabled={busy || !name.trim()}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <button
          type="button"
          onClick={toggleArchive}
          disabled={busy}
          className="text-xs text-neutral-600 hover:underline"
        >
          {account.archived ? 'Restore' : 'Archive'}
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  wide,
  children,
}: {
  label: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
