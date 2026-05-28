// Relationships between this contact and others (parent/student, sibling,
// caseworker, tutor, etc). The reciprocal link is written on the server.
// CLAUDE.md §6.

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

type Relation =
  | 'parent_of'
  | 'child_of'
  | 'guardian_of'
  | 'sibling_of'
  | 'spouse_of'
  | 'partner_of'
  | 'caseworker_for'
  | 'tutor_of'
  | 'student_of'
  | 'other'

const RELATION_LABELS: Record<Relation, string> = {
  parent_of: 'Parent of',
  child_of: 'Child of',
  guardian_of: 'Guardian of',
  sibling_of: 'Sibling of',
  spouse_of: 'Spouse of',
  partner_of: 'Partner of',
  caseworker_for: 'Caseworker for',
  tutor_of: 'Tutor of',
  student_of: 'Student of',
  other: 'Linked to',
}

interface Props {
  contactId: string
}

export function LinkedContactsSection({ contactId }: Props) {
  const router = useRouter()
  const links = trpc.contact.links.list.useQuery({ contactId })
  const addLink = trpc.contact.links.add.useMutation()
  const removeLink = trpc.contact.links.remove.useMutation()

  const [pickerOpen, setPickerOpen] = useState(false)
  const [relation, setRelation] = useState<Relation>('parent_of')
  const [q, setQ] = useState('')
  const candidatesQuery = trpc.contact.links.candidates.useQuery(
    { excludeContactId: contactId, q, limit: 8 },
    { enabled: pickerOpen && q.trim().length > 0 },
  )
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (pickerOpen) inputRef.current?.focus()
  }, [pickerOpen])

  async function pick(otherId: string) {
    try {
      await addLink.mutateAsync({
        fromContactId: contactId,
        toContactId: otherId,
        relation,
      })
      toast.success('Linked')
      setQ('')
      setPickerOpen(false)
      await links.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not link')
    }
  }

  async function unlink(linkId: string) {
    try {
      await removeLink.mutateAsync({ id: linkId })
      toast.success('Unlinked')
      await links.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not unlink')
    }
  }

  const data = links.data ?? []

  return (
    <div className="space-y-3">
      {data.length === 0 && !pickerOpen ? (
        <p className="text-sm text-neutral-500">
          No links yet — connect this contact to a parent, student, sibling, caseworker, tutor, or any other person you track here.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {data.map((l) => (
            <li key={l.id} className="flex items-center gap-3 py-2.5">
              <Avatar name={l.contact.displayName} size={32} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                    {RELATION_LABELS[l.relation as Relation] ?? 'Linked to'}
                  </span>
                  <Link
                    href={`/contacts/${l.contact.id}`}
                    className="truncate text-sm font-medium text-neutral-900 hover:text-primary-700 hover:underline"
                  >
                    {l.contact.displayName}
                  </Link>
                </div>
                <div className="truncate text-xs text-neutral-500">
                  {l.contact.email ?? <span className="text-neutral-400">no email</span>}
                  {l.contact.phoneE164 ? (
                    <>
                      {' · '}
                      <span className="font-mono">{l.contact.phoneE164}</span>
                    </>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => unlink(l.id)}
                aria-label={`Unlink ${l.contact.displayName}`}
                className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
              >
                <XIcon size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {pickerOpen ? (
        <div className="rounded-lg border border-primary-200 bg-primary-50/30 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                Relationship
              </label>
              <Select
                value={relation}
                onChange={(e) => setRelation(e.target.value as Relation)}
                className="min-w-[10rem]"
              >
                <option value="parent_of">Parent of</option>
                <option value="child_of">Child of</option>
                <option value="guardian_of">Guardian of</option>
                <option value="sibling_of">Sibling of</option>
                <option value="spouse_of">Spouse of</option>
                <option value="partner_of">Partner of</option>
                <option value="caseworker_for">Caseworker for</option>
                <option value="tutor_of">Tutor of</option>
                <option value="student_of">Student of</option>
                <option value="other">Other</option>
              </Select>
            </div>
            <div className="flex-1 space-y-1">
              <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                Search contact
              </label>
              <Input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name, email, or phone"
              />
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>
              Cancel
            </Button>
          </div>

          {q.trim().length > 0 ? (
            <div className="mt-2 max-h-64 overflow-y-auto rounded-md border border-neutral-200 bg-white">
              {candidatesQuery.isLoading ? (
                <p className="p-3 text-xs text-neutral-500">Searching…</p>
              ) : (candidatesQuery.data?.length ?? 0) === 0 ? (
                <p className="p-3 text-xs text-neutral-500">No matches.</p>
              ) : (
                <ul>
                  {candidatesQuery.data?.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => pick(c.id)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-neutral-50"
                      >
                        <Avatar name={c.displayName} size={28} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-neutral-900">
                            {c.displayName}
                          </div>
                          <div className="truncate text-xs text-neutral-500">
                            {c.email ?? c.phoneE164 ?? ''}
                          </div>
                        </div>
                        <span className="text-[10px] uppercase tracking-wide text-neutral-400">
                          {c.kind.replace('_', ' ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <Button type="button" size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
          Link a contact
        </Button>
      )}
    </div>
  )
}
