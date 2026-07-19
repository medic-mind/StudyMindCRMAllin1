// Automated Direct Debit chasing workspace (ADR 0045). One row per person
// being chased: who, what they owe, their individual re-signup link, which
// channels we message them on, how far up the escalation ladder they are, and
// the two ways it stops — the engine spotting a fresh mandate, or a human
// pressing "Up to date". Manager+ writes (server-enforced); all staff read.

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { trpc } from '@/lib/trpc/client'

import { ContactSearch, formatDate } from './shared'

type View = 'open' | 'needs_link' | 'resolved' | 'all'

const VIEWS: { key: View; label: string }[] = [
  { key: 'open', label: 'Being chased' },
  { key: 'needs_link', label: 'Needs link' },
  { key: 'resolved', label: 'Up to date' },
  { key: 'all', label: 'All' },
]

function pounds(minor: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)
}

export function ChasingTab({ canWrite }: { canWrite: boolean }) {
  const [view, setView] = useState<View>('open')
  const [adding, setAdding] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const utils = trpc.useUtils()
  const list = trpc.finance.directDebit.cases.chaseList.useQuery({ view })

  const refresh = () => utils.finance.directDebit.cases.chaseList.invalidate()

  const update = trpc.finance.directDebit.cases.updateChase.useMutation({
    onSuccess: () => void refresh(),
    onError: (e) => toast.error(e.message),
  })
  const markUpToDate = trpc.finance.directDebit.cases.markUpToDate.useMutation({
    onSuccess: () => {
      toast.success('Marked up to date — all automated messages stopped.')
      void refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  const rows = list.data ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
        <span>
          People here get the escalating chase emails/texts automatically (each step more serious)
          until they set their Direct Debit back up — detected from GoCardless — or someone presses{' '}
          <span className="font-medium">Up to date</span>. Nothing sends until a re-signup link is
          on the row. Message copy lives in{' '}
          <Link
            href="/settings/dd-recovery-templates"
            className="font-medium text-primary-700 hover:underline"
          >
            recovery templates
          </Link>
          .
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => setView(v.key)}
              className={
                view === v.key
                  ? 'rounded-full bg-primary-700 px-3 py-1 text-xs font-medium text-white'
                  : 'rounded-full bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-200'
              }
            >
              {v.label}
            </button>
          ))}
        </div>
        {canWrite ? (
          <div className="ml-auto">
            <Button type="button" size="sm" onClick={() => setAdding((a) => !a)}>
              {adding ? 'Close' : 'Add customer'}
            </Button>
          </div>
        ) : null}
      </div>

      {adding ? <AddChaseForm onDone={() => { setAdding(false); void refresh() }} /> : null}

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-neutral-600">
            {list.isLoading
              ? 'Loading…'
              : view === 'needs_link'
                ? 'Nothing waiting for a link.'
                : view === 'open'
                  ? 'Nobody is being chased right now. Add a customer, or the nightly scan opens cases for cancelled plans with money outstanding.'
                  : 'Nothing here.'}
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Customer</Th>
                <Th>Owed</Th>
                <Th>Re-signup link</Th>
                <Th>Channels</Th>
                <Th>Progress</Th>
                <Th>Status</Th>
                {canWrite ? <Th>Actions</Th> : null}
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((r) => (
                <ChaseRow
                  key={r.id}
                  row={r}
                  canWrite={canWrite}
                  expanded={expandedId === r.id}
                  onToggleExpand={() => setExpandedId(expandedId === r.id ? null : r.id)}
                  onUpdate={(patch) => update.mutate({ caseId: r.id, ...patch })}
                  onUpToDate={() => markUpToDate.mutate({ caseId: r.id })}
                  busy={update.isPending || markUpToDate.isPending}
                />
              ))}
            </Tbody>
          </Table>
        )}
      </div>
    </div>
  )
}

interface ChaseRowData {
  id: string
  status: string
  contactId: string | null
  contactName: string | null
  gcSubscriptionId: string | null
  outstandingMinor: number
  autoChase: boolean
  sendEmails: boolean
  sendTexts: boolean
  chaseEmail: string | null
  chasePhoneE164: string | null
  setupLinkUrl: string | null
  cadenceDays: number
  escalationStep: number
  lastAutoMessageAt: Date | string | null
  nextAutoMessageAt: Date | string | null
  messageCount: number
  createdAt: Date | string
  recoveredAt: Date | string | null
  recoveryMethod: string | null
}

function ChaseRow({
  row: r,
  canWrite,
  expanded,
  onToggleExpand,
  onUpdate,
  onUpToDate,
  busy,
}: {
  row: ChaseRowData
  canWrite: boolean
  expanded: boolean
  onToggleExpand: () => void
  onUpdate: (patch: {
    autoChase?: boolean
    sendEmails?: boolean
    sendTexts?: boolean
    setupLinkUrl?: string | null
  }) => void
  onUpToDate: () => void
  busy: boolean
}) {
  const [editingLink, setEditingLink] = useState(false)
  const [link, setLink] = useState(r.setupLinkUrl ?? '')
  const open = r.status === 'new' || r.status === 'chasing' || r.status === 'escalated'

  return (
    <>
      <Tr className="align-top">
        <Td>
          <div className="font-medium text-neutral-900">
            {r.contactId ? (
              <Link href={`/contacts/${r.contactId}`} className="hover:underline">
                {r.contactName ?? 'Contact'}
              </Link>
            ) : (
              (r.contactName ?? '—')
            )}
          </div>
          <div className="text-xs text-neutral-500">
            {r.chaseEmail ?? 'no email'} · {r.chasePhoneE164 ?? 'no phone'}
          </div>
        </Td>
        <Td className="whitespace-nowrap font-medium tabular-nums">{pounds(r.outstandingMinor)}</Td>
        <Td>
          {editingLink && canWrite ? (
            <div className="flex items-center gap-1">
              <Input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://pay.gocardless.com/… or Stripe link"
                className="h-8 w-56 text-xs"
              />
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => {
                  onUpdate({ setupLinkUrl: link.trim() || null })
                  setEditingLink(false)
                }}
              >
                Save
              </Button>
            </div>
          ) : r.setupLinkUrl ? (
            <div className="flex items-center gap-1.5">
              <a
                href={r.setupLinkUrl}
                target="_blank"
                rel="noreferrer"
                className="max-w-[180px] truncate text-xs text-primary-700 hover:underline"
              >
                {r.setupLinkUrl}
              </a>
              {canWrite && open ? (
                <button
                  type="button"
                  className="text-xs text-neutral-500 hover:underline"
                  onClick={() => setEditingLink(true)}
                >
                  edit
                </button>
              ) : null}
            </div>
          ) : canWrite && open ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditingLink(true)}>
              Add link to start
            </Button>
          ) : (
            <Badge tone="warn">needs link</Badge>
          )}
        </Td>
        <Td>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!canWrite || !open || busy}
              onClick={() => onUpdate({ sendEmails: !r.sendEmails })}
              className={
                r.sendEmails
                  ? 'rounded-full bg-primary-100 px-2 py-0.5 text-[11px] font-medium text-primary-800'
                  : 'rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-400'
              }
              title="Toggle automated emails for this person"
            >
              Email {r.sendEmails ? 'on' : 'off'}
            </button>
            <button
              type="button"
              disabled={!canWrite || !open || busy}
              onClick={() => onUpdate({ sendTexts: !r.sendTexts })}
              className={
                r.sendTexts
                  ? 'rounded-full bg-primary-100 px-2 py-0.5 text-[11px] font-medium text-primary-800'
                  : 'rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-400'
              }
              title="Toggle automated texts for this person"
            >
              Text {r.sendTexts ? 'on' : 'off'}
            </button>
          </div>
        </Td>
        <Td className="whitespace-nowrap text-xs text-neutral-600">
          {r.messageCount > 0 ? (
            <button type="button" className="hover:underline" onClick={onToggleExpand}>
              Step {r.escalationStep} · {r.messageCount} sent {expanded ? '▴' : '▾'}
            </button>
          ) : (
            'Nothing sent yet'
          )}
          {open && r.nextAutoMessageAt ? (
            <div className="text-neutral-400">next {formatDate(r.nextAutoMessageAt)}</div>
          ) : null}
        </Td>
        <Td>
          {r.status === 'recovered' ? (
            <Badge tone="success">up to date</Badge>
          ) : r.status === 'written_off' ? (
            <Badge tone="neutral">written off</Badge>
          ) : !r.autoChase ? (
            <Badge tone="warn">paused</Badge>
          ) : r.setupLinkUrl ? (
            <Badge tone="info">chasing</Badge>
          ) : (
            <Badge tone="warn">needs link</Badge>
          )}
        </Td>
        {canWrite ? (
          <Td>
            {open ? (
              <div className="flex flex-wrap items-center gap-1">
                <Button type="button" size="sm" disabled={busy} onClick={onUpToDate}>
                  Up to date ✓
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => onUpdate({ autoChase: !r.autoChase })}
                >
                  {r.autoChase ? 'Pause' : 'Resume'}
                </Button>
              </div>
            ) : null}
          </Td>
        ) : null}
      </Tr>
      {expanded ? (
        <Tr>
          <Td colSpan={canWrite ? 7 : 6} className="bg-neutral-50">
            <ChaseHistory caseId={r.id} />
          </Td>
        </Tr>
      ) : null}
    </>
  )
}

function ChaseHistory({ caseId }: { caseId: string }) {
  const messages = trpc.finance.directDebit.cases.chaseMessages.useQuery({ caseId })
  const rows = messages.data ?? []
  if (messages.isLoading) return <p className="p-2 text-xs text-neutral-500">Loading history…</p>
  if (rows.length === 0) return <p className="p-2 text-xs text-neutral-500">No messages yet.</p>
  return (
    <ul className="space-y-2 p-2">
      {rows.map((m) => (
        <li key={m.id} className="rounded border border-neutral-200 bg-white p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2 text-neutral-600">
            <Badge tone={m.status === 'sent' ? 'success' : 'danger'}>
              {m.channel} · step {m.step + 1}
            </Badge>
            <span>to {m.toAddress}</span>
            <span className="ml-auto text-neutral-400">{formatDate(m.createdAt)}</span>
          </div>
          {m.subject ? <div className="mt-1 font-medium">{m.subject}</div> : null}
          <div className="mt-1 whitespace-pre-wrap text-neutral-700">{m.body}</div>
          {m.error ? <div className="mt-1 text-red-700">Failed: {m.error}</div> : null}
        </li>
      ))}
    </ul>
  )
}

function AddChaseForm({ onDone }: { onDone: () => void }) {
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null)
  const [owedPounds, setOwedPounds] = useState('')
  const [link, setLink] = useState('')
  const [email, setEmail] = useState(true)
  const [text, setText] = useState(false)

  const create = trpc.finance.directDebit.cases.openManualChase.useMutation({
    onSuccess: () => {
      toast.success('Added to the chase list.')
      onDone()
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
      <p className="text-sm font-medium text-neutral-900">Add a customer to chase</p>
      {contact ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{contact.name}</span>
          <button
            type="button"
            className="text-xs text-neutral-500 hover:underline"
            onClick={() => setContact(null)}
          >
            change
          </button>
        </div>
      ) : (
        <ContactSearch onPick={(id, name) => setContact({ id, name })} />
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-neutral-600">
          Outstanding (£)
          <Input
            value={owedPounds}
            onChange={(e) => setOwedPounds(e.target.value)}
            placeholder="0.00"
            className="mt-1 w-28"
          />
        </label>
        <label className="grow text-xs text-neutral-600">
          Re-signup link (GoCardless or Stripe) — messages only start once this is set
          <Input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…"
            className="mt-1"
          />
        </label>
      </div>
      <div className="flex items-center gap-4 text-sm text-neutral-700">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
          Send emails
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={text} onChange={(e) => setText(e.target.checked)} />
          Send texts
        </label>
        <div className="ml-auto">
          <Button
            type="button"
            disabled={!contact || create.isPending}
            onClick={() => {
              const minor = Math.round((Number.parseFloat(owedPounds || '0') || 0) * 100)
              create.mutate({
                contactId: contact!.id,
                outstandingMinor: Math.max(0, minor),
                setupLinkUrl: link.trim() || null,
                sendEmails: email,
                sendTexts: text,
              })
            }}
          >
            {create.isPending ? 'Adding…' : 'Add to chase list'}
          </Button>
        </div>
      </div>
    </div>
  )
}
