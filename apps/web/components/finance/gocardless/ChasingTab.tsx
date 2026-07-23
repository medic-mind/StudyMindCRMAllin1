'use client'

// Direct Debit collections — the recovery-cases worklist (ADR 0045 amendment).
// Merged into the single Issues tab: the people who owe money and are being
// (or waiting to be) chased. Each row opens the full case detail (comms
// history, manual send, automatic recovery). A case can be a CRM contact OR a
// standalone person who predates the CRM. Manager+ writes are server-enforced;
// all staff read.

import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { trpc } from '@/lib/trpc/client'

import { CaseDetailModal } from './CaseDetailModal'
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

export function RecoveryCasesSection({ canWrite }: { canWrite: boolean }) {
  const [view, setView] = useState<View>('open')
  const [adding, setAdding] = useState(false)
  const [openCaseId, setOpenCaseId] = useState<string | null>(null)

  const utils = trpc.useUtils()
  const list = trpc.finance.directDebit.cases.chaseList.useQuery({ view })
  const refresh = () => utils.finance.directDebit.cases.chaseList.invalidate()

  const rows = list.data ?? []

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-sm font-semibold text-neutral-900">Recovery cases</h2>
        <p className="text-xs text-neutral-500">
          Underpaid or cancelled-early Direct Debits being chased. Open a person for their full
          history, to send a message, or to start the automatic recovery.
        </p>
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
              {adding ? 'Close' : 'Add a person'}
            </Button>
          </div>
        ) : null}
      </div>

      {adding ? (
        <AddChaseForm
          onDone={(id) => {
            setAdding(false)
            void refresh()
            if (id) setOpenCaseId(id)
          }}
        />
      ) : null}

      <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-neutral-600">
            {list.isLoading
              ? 'Loading…'
              : view === 'needs_link'
                ? 'Nothing waiting for a link.'
                : view === 'open'
                  ? 'Nobody is being chased right now. Add a person, or start one from a detected issue below.'
                  : 'Nothing here.'}
          </p>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Person</Th>
                <Th className="text-right">Owed</Th>
                <Th>Progress</Th>
                <Th>Status</Th>
                <Th />
              </Tr>
            </Thead>
            <Tbody>
              {rows.map((r) => (
                <Tr key={r.id} className="align-top">
                  <Td>
                    <button
                      type="button"
                      className="text-left font-medium text-neutral-900 hover:underline"
                      onClick={() => setOpenCaseId(r.id)}
                    >
                      {r.name}
                    </button>
                    <div className="text-xs text-neutral-500">
                      {r.chaseEmail ?? 'no email'} · {r.chasePhoneE164 ?? 'no phone'}
                      {r.contactId ? '' : ' · not in CRM'}
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-right font-medium tabular-nums">
                    {pounds(r.outstandingMinor)}
                  </Td>
                  <Td className="whitespace-nowrap text-xs text-neutral-600">
                    {r.messageCount > 0
                      ? `Step ${r.escalationStep + 1} · ${r.messageCount} sent`
                      : 'Nothing sent yet'}
                    {(r.status === 'new' || r.status === 'chasing' || r.status === 'escalated') &&
                    r.nextAutoMessageAt ? (
                      <div className="text-neutral-400">next {formatDate(r.nextAutoMessageAt)}</div>
                    ) : null}
                  </Td>
                  <Td>
                    <StatusBadge row={r} />
                  </Td>
                  <Td className="text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setOpenCaseId(r.id)}
                    >
                      Open
                    </Button>
                  </Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </div>

      {openCaseId ? (
        <CaseDetailModal
          caseId={openCaseId}
          canWrite={canWrite}
          onClose={() => {
            setOpenCaseId(null)
            void refresh()
          }}
        />
      ) : null}
    </section>
  )
}

function StatusBadge({
  row: r,
}: {
  row: { status: string; autoChase: boolean; setupLinkUrl: string | null }
}) {
  if (r.status === 'recovered') return <Badge tone="success">up to date</Badge>
  if (r.status === 'written_off') return <Badge tone="neutral">written off</Badge>
  if (!r.autoChase) return <Badge tone="warn">paused</Badge>
  if (r.setupLinkUrl) return <Badge tone="info">chasing</Badge>
  return <Badge tone="warn">needs link</Badge>
}

// -----------------------------------------------------------------------------
// Add a person to chase — an existing CRM contact OR a standalone person.
// -----------------------------------------------------------------------------

function AddChaseForm({ onDone }: { onDone: (createdCaseId?: string) => void }) {
  const [mode, setMode] = useState<'contact' | 'standalone'>('standalone')
  const [contact, setContact] = useState<{ id: string; name: string } | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [owedPounds, setOwedPounds] = useState('')
  const [link, setLink] = useState('')
  const [sendEmails, setSendEmails] = useState(true)
  const [sendTexts, setSendTexts] = useState(false)

  const create = trpc.finance.directDebit.cases.openManualChase.useMutation({
    onSuccess: (res) => {
      toast.success('Added to the recovery list.')
      onDone(res.id)
    },
    onError: (e) => toast.error(e.message),
  })

  function submit() {
    const minor = Math.round((Number.parseFloat(owedPounds || '0') || 0) * 100)
    create.mutate({
      contactId: mode === 'contact' ? (contact?.id ?? null) : null,
      personName: mode === 'standalone' ? name.trim() || null : null,
      outstandingMinor: Math.max(0, minor),
      setupLinkUrl: link.trim() || null,
      sendEmails,
      sendTexts,
      chaseEmail: mode === 'standalone' ? email.trim() || null : null,
      chasePhoneE164: mode === 'standalone' ? phone.trim() || null : null,
    })
  }

  const canSubmit =
    mode === 'contact' ? Boolean(contact) : name.trim().length > 0 && !create.isPending

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
      <p className="text-sm font-medium text-neutral-900">Add a person to chase</p>

      <div className="inline-flex rounded-md border border-neutral-200 p-0.5 text-sm">
        {(
          [
            { key: 'standalone', label: 'New person (not in CRM)' },
            { key: 'contact', label: 'Existing contact' },
          ] as const
        ).map((m) => (
          <button
            key={m.key}
            type="button"
            className={`rounded px-3 py-1 ${
              mode === m.key ? 'bg-neutral-900 text-white' : 'text-neutral-600'
            }`}
            onClick={() => setMode(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'contact' ? (
        contact ? (
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
          <ContactSearch onPick={(id, nm) => setContact({ id, name: nm })} />
        )
      ) : (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="text-xs text-neutral-600">
            Name
            <Input value={name} onChange={(e) => setName(e.target.value)} className="mt-1" />
          </label>
          <label className="text-xs text-neutral-600">
            Email
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="mt-1"
            />
          </label>
          <label className="text-xs text-neutral-600">
            Phone (+…)
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+447…"
              className="mt-1"
            />
          </label>
        </div>
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

      <div className="flex flex-wrap items-center gap-4 text-sm text-neutral-700">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={sendEmails}
            onChange={(e) => setSendEmails(e.target.checked)}
          />
          Send emails
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={sendTexts} onChange={(e) => setSendTexts(e.target.checked)} />
          Send texts
        </label>
        <div className="ml-auto">
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            {create.isPending ? 'Adding…' : 'Add to recovery list'}
          </Button>
        </div>
      </div>
    </div>
  )
}
