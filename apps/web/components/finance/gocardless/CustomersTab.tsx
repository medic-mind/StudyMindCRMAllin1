'use client'

// GoCardless customers + mandates tab (ADR 0038). Linking a customer to a CRM
// contact is the explicit human decision that connects payments to the
// timeline — the import only auto-links unambiguous email matches, never
// merges (CLAUDE.md §3, §41.1). Also hosts the mandate setup-link generator
// ("create a Direct Debit" for someone new).

import Link from 'next/link'
import { Fragment, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { trpc } from '@/lib/trpc/client'

import { ContactSearch, FilterChips, formatDate, MANDATE_TONE, statusLabel } from './shared'

const LINK_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'unlinked', label: 'Needs linking' },
  { value: 'linked', label: 'Linked' },
] as const

type LinkFilter = (typeof LINK_OPTIONS)[number]['value']

export function CustomersTab() {
  const [link, setLink] = useState<LinkFilter>('all')
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [linking, setLinking] = useState<string | null>(null)
  const [showSetupLink, setShowSetupLink] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250)
    return () => clearTimeout(t)
  }, [q])

  const utils = trpc.useUtils()
  const list = trpc.gocardless.customers.list.useQuery({
    link,
    ...(debounced.trim().length >= 2 ? { q: debounced.trim() } : {}),
  })

  const linkMutation = trpc.gocardless.customers.link.useMutation({
    onSuccess: (res) => {
      toast.success(
        res.contactId
          ? `Linked${res.linkedMandates ? ` — ${res.linkedMandates} mandate(s) now reconcile` : ''}.`
          : 'Link removed.',
      )
      setLinking(null)
      void utils.gocardless.customers.list.invalidate()
      void utils.gocardless.overview.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const items = list.data?.items ?? []

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FilterChips options={LINK_OPTIONS} value={link} onChange={setLink} />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name or email…"
            className="h-8 w-64"
          />
        </div>
        <Button size="sm" onClick={() => setShowSetupLink((v) => !v)}>
          {showSetupLink ? 'Close' : 'New Direct Debit setup link'}
        </Button>
      </div>

      {showSetupLink ? <SetupLinkForm /> : null}

      {list.isLoading ? (
        <p className="px-1 py-6 text-sm text-neutral-500">Loading customers…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-card">
          <p className="text-sm font-medium text-neutral-700">No GoCardless customers found.</p>
          <p className="mt-1 text-sm text-neutral-500">
            Run the import (top right) to mirror every customer, mandate, plan and payment.
          </p>
        </div>
      ) : (
        <div className="rounded-lg border border-neutral-200 bg-white shadow-card">
          <Table>
            <Thead>
              <Tr>
                <Th>GoCardless customer</Th>
                <Th>CRM contact</Th>
                <Th className="text-right">Mandates</Th>
                <Th className="text-right">Active plans</Th>
                <Th>Customer since</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {items.map((c) => (
                <Fragment key={c.gcCustomerId}>
                  <Tr>
                    <Td>
                      <div className="font-medium text-neutral-900">
                        {c.name ?? c.email ?? c.gcCustomerId}
                      </div>
                      {c.email ? (
                        <div className="text-xs text-neutral-500">{c.email}</div>
                      ) : null}
                    </Td>
                    <Td>
                      {c.contactId ? (
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/contacts/${c.contactId}`}
                            className="font-medium text-primary-700 hover:underline"
                          >
                            {c.contactName ?? 'View contact'}
                          </Link>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={linkMutation.isPending}
                            onClick={() =>
                              linkMutation.mutate({
                                gcCustomerId: c.gcCustomerId,
                                contactId: null,
                              })
                            }
                          >
                            Unlink
                          </Button>
                        </div>
                      ) : linking === c.gcCustomerId ? (
                        <div className="max-w-md">
                          <ContactSearch
                            busy={linkMutation.isPending}
                            onPick={(contactId) =>
                              linkMutation.mutate({ gcCustomerId: c.gcCustomerId, contactId })
                            }
                          />
                          <Button
                            size="xs"
                            variant="ghost"
                            className="mt-1"
                            onClick={() => setLinking(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => setLinking(c.gcCustomerId)}
                        >
                          Link to contact
                        </Button>
                      )}
                    </Td>
                    <Td className="text-right tabular-nums">{c.mandateCount}</Td>
                    <Td className="text-right tabular-nums">{c.activeSubscriptionCount}</Td>
                    <Td className="text-neutral-600">{formatDate(c.gcCreatedAt)}</Td>
                    <Td>
                      <div className="flex justify-end">
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            setExpanded(
                              expanded === c.gcCustomerId ? null : c.gcCustomerId,
                            )
                          }
                        >
                          {expanded === c.gcCustomerId ? 'Hide mandates' : 'Mandates'}
                        </Button>
                      </div>
                    </Td>
                  </Tr>
                  {expanded === c.gcCustomerId ? (
                    <Tr>
                      <Td colSpan={6} className="bg-neutral-50">
                        <CustomerMandates gcCustomerId={c.gcCustomerId} />
                      </Td>
                    </Tr>
                  ) : null}
                </Fragment>
              ))}
            </Tbody>
          </Table>
        </div>
      )}
    </div>
  )
}

function CustomerMandates({ gcCustomerId }: { gcCustomerId: string }) {
  const utils = trpc.useUtils()
  const [cancelTarget, setCancelTarget] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const mandates = trpc.gocardless.mandates.list.useQuery({ gcCustomerId, limit: 20 })

  const cancel = trpc.gocardless.mandates.cancel.useMutation({
    onSuccess: () => {
      toast.success('Mandate cancelled.')
      setCancelTarget(null)
      setReason('')
      void utils.gocardless.mandates.list.invalidate()
      void utils.gocardless.customers.list.invalidate()
      void utils.gocardless.overview.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const items = mandates.data?.items ?? []
  if (mandates.isLoading) {
    return <p className="px-2 py-2 text-xs text-neutral-500">Loading mandates…</p>
  }
  if (items.length === 0) {
    return <p className="px-2 py-2 text-xs text-neutral-500">No mandates for this customer.</p>
  }
  return (
    <div className="space-y-2 px-2 py-1">
      {items.map((m) => (
        <div
          key={m.gcMandateId}
          className="flex flex-wrap items-center justify-between gap-2 text-sm"
        >
          <span className="flex items-center gap-2">
            <code className="font-mono text-xs">{m.gcMandateId}</code>
            {m.reference ? (
              <span className="text-xs text-neutral-500">ref {m.reference}</span>
            ) : null}
            {m.scheme ? <span className="text-xs text-neutral-400">{m.scheme}</span> : null}
            <Badge tone={MANDATE_TONE[m.state] ?? 'neutral'} dot>
              {statusLabel(m.state)}
            </Badge>
            {m.nextPossibleChargeDate ? (
              <span className="text-xs text-neutral-500">
                next chargeable {formatDate(m.nextPossibleChargeDate)}
              </span>
            ) : null}
          </span>
          {['active', 'submitted', 'pending_submission'].includes(m.state) ? (
            cancelTarget === m.gcMandateId ? (
              <span className="flex items-center gap-2">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (audited)"
                  className="h-7 w-56 text-xs"
                />
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={cancel.isPending || reason.trim().length < 2}
                  onClick={() =>
                    cancel.mutate({ gcMandateId: m.gcMandateId, reason: reason.trim() })
                  }
                >
                  {cancel.isPending ? 'Cancelling…' : 'Confirm cancel'}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setCancelTarget(null)
                    setReason('')
                  }}
                >
                  Back
                </Button>
              </span>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                className="text-red-700"
                onClick={() => setCancelTarget(m.gcMandateId)}
              >
                Cancel mandate
              </Button>
            )
          ) : null}
        </div>
      ))}
    </div>
  )
}

function SetupLinkForm() {
  const [picked, setPicked] = useState<{ contactId: string; name: string } | null>(null)
  const [url, setUrl] = useState<string | null>(null)

  const create = trpc.gocardless.mandates.createSetupLink.useMutation({
    onSuccess: (res) => setUrl(res.url),
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
      <div>
        <Label>Set up a new Direct Debit</Label>
        <p className="mt-0.5 text-xs text-neutral-500">
          Pick the bill-payer; we generate a secure GoCardless page where they confirm their bank
          details. Send them the link by email or message — it expires after about 30 minutes, so
          generate it when you’re ready to send. The mandate appears here the moment they finish.
        </p>
      </div>
      {url ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input readOnly value={url} className="font-mono text-xs" />
            <Button
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(url)
                toast.success('Link copied.')
              }}
            >
              Copy
            </Button>
          </div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setUrl(null)
              setPicked(null)
            }}
          >
            Generate another
          </Button>
        </div>
      ) : picked ? (
        <div className="flex items-center gap-2">
          <span className="text-sm">
            For <span className="font-medium">{picked.name}</span>
          </span>
          <Button
            size="sm"
            disabled={create.isPending}
            onClick={() => create.mutate({ contactId: picked.contactId })}
          >
            {create.isPending ? 'Generating…' : 'Generate link'}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>
            Change contact
          </Button>
        </div>
      ) : (
        <div className="max-w-md">
          <ContactSearch
            placeholder="Search for the bill-payer…"
            onPick={(contactId, name) => setPicked({ contactId, name })}
          />
        </div>
      )}
    </div>
  )
}
