// Linked contacts panel for a B2B account. Lists the contacts attached to
// the account with their role (head teacher, SENCo, partnership lead…),
// inline-add via contact search, inline-unlink.

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

interface LinkedContact {
  contactId: string
  role: string | null
  firstName: string | null
  lastName: string | null
  email: string | null
  phoneE164: string | null
  jobTitle: string | null
  kind: string
}

interface Account {
  id: string
  kind: 'school' | 'partnership'
  contacts: LinkedContact[]
}

function displayName(c: LinkedContact): string {
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
  return n.length > 0 ? n : (c.email ?? 'Unnamed contact')
}

export function AccountContacts({ account }: { account: Account }) {
  const router = useRouter()
  const [picking, setPicking] = useState(false)

  const link = trpc.businessAccount.contacts.link.useMutation()
  const unlink = trpc.businessAccount.contacts.unlink.useMutation()

  async function unlinkContact(contactId: string) {
    try {
      await unlink.mutateAsync({ accountId: account.id, contactId })
      toast.success('Contact unlinked')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not unlink')
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-900">Contacts</h2>
        {!picking && (
          <Button type="button" size="sm" onClick={() => setPicking(true)}>
            + Add
          </Button>
        )}
      </div>

      {picking && (
        <LinkPicker
          accountId={account.id}
          existingContactIds={account.contacts.map((c) => c.contactId)}
          onClose={() => setPicking(false)}
          onLinked={async (contactId, role) => {
            try {
              await link.mutateAsync({
                accountId: account.id,
                contactId,
                role: role.trim() || undefined,
              })
              toast.success('Contact linked')
              setPicking(false)
              router.refresh()
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Could not link')
            }
          }}
        />
      )}

      {account.contacts.length === 0 ? (
        <p className="text-xs text-neutral-500">
          No contacts linked yet. Use <em>+ Add</em> to attach the head teacher,
          SENCo, programme lead, etc.
        </p>
      ) : (
        <ul className="space-y-2">
          {account.contacts.map((c) => (
            <li
              key={c.contactId}
              className="rounded-md border border-neutral-200 p-3 text-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    href={`/contacts/${c.contactId}`}
                    className="font-medium text-primary-700 hover:underline"
                  >
                    {displayName(c)}
                  </Link>
                  {c.role && (
                    <div className="text-xs text-neutral-600">{c.role}</div>
                  )}
                  {c.jobTitle && !c.role && (
                    <div className="text-xs text-neutral-600">{c.jobTitle}</div>
                  )}
                  <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
                    {c.email && <span>{c.email}</span>}
                    {c.phoneE164 && <span className="font-mono">{c.phoneE164}</span>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => unlinkContact(c.contactId)}
                  className="shrink-0 text-xs text-neutral-500 hover:text-red-700 hover:underline"
                >
                  Unlink
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function LinkPicker({
  accountId: _accountId,
  existingContactIds,
  onClose,
  onLinked,
}: {
  accountId: string
  existingContactIds: string[]
  onClose: () => void
  onLinked: (contactId: string, role: string) => void
}) {
  const [q, setQ] = useState('')
  const [pickedId, setPickedId] = useState('')
  const [role, setRole] = useState('')

  const search = trpc.contact.list.useQuery(
    { q, limit: 8 },
    { enabled: q.trim().length >= 2 },
  )

  const existing = new Set(existingContactIds)
  const results = (search.data?.items ?? []).filter((c) => !existing.has(c.id))

  return (
    <div className="space-y-2 rounded-md border border-primary-200 bg-primary-50/30 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-700">
          Link a contact
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>
      <Input
        type="search"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setPickedId('')
        }}
        placeholder="Search contacts by name or email…"
      />
      {q.trim().length >= 2 && (
        <ul className="max-h-40 overflow-y-auto rounded border border-neutral-200 bg-white text-sm">
          {results.length === 0 && !search.isLoading && (
            <li className="px-3 py-2 text-xs text-neutral-500">No matches</li>
          )}
          {results.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => setPickedId(c.id)}
                className={
                  pickedId === c.id
                    ? 'block w-full px-3 py-1.5 text-left text-sm font-medium text-primary-800 bg-primary-50'
                    : 'block w-full px-3 py-1.5 text-left text-sm text-neutral-800 hover:bg-neutral-50'
                }
              >
                {c.displayName}
                {c.email ? (
                  <span className="ml-2 text-xs text-neutral-500">{c.email}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Input
        value={role}
        onChange={(e) => setRole(e.target.value)}
        placeholder="Role at this account (e.g. Head teacher, SENCo)"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => pickedId && onLinked(pickedId, role)}
          disabled={!pickedId}
        >
          Link
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
