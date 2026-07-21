'use client'

// Direct Debit collections — the per-person case detail (ADR 0045 amendment).
// One place to open someone who owes money (a CRM contact OR a standalone
// person who predates the CRM), see every message ever sent them, send a manual
// message (email or Trengo SMS) from a template, and arm/adjust the automatic
// recovery. Manager+ writes are server-enforced; all staff can read.

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

// Pure template helper via the subpath (NOT the finance barrel, which pulls in
// node:crypto and breaks the client bundle) — same as SendRecoveryDialog.
import { renderRecoveryTemplate } from '@studymind/core/finance/dd-comms'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc, type RouterOutputs } from '@/lib/trpc/client'

import { formatDate } from './shared'

type Detail = RouterOutputs['finance']['directDebit']['cases']['caseDetail']

const STATUS_TONE: Record<string, BadgeTone> = {
  new: 'neutral',
  chasing: 'info',
  escalated: 'danger',
  recovered: 'success',
  written_off: 'neutral',
}

const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  chasing: 'Chasing',
  escalated: 'Escalated',
  recovered: 'Up to date',
  written_off: 'Written off',
}

type Channel = 'email' | 'sms'

/** The one-line "are they on the automated reminder system?" answer — the exact
 *  thing the operator asked to see at a glance. Pure. */
function automationStatusLine(d: Detail): { text: string; tone: 'on' | 'off' | 'warn' } {
  if (d.status === 'recovered') return { text: 'Recovered — automated reminders stopped', tone: 'off' }
  if (d.status === 'written_off') return { text: 'Written off — automated reminders stopped', tone: 'off' }
  const armed = d.autoChase && (d.sendEmails || d.sendTexts)
  if (!armed) return { text: 'Automated reminders are OFF for this person', tone: 'off' }
  if (d.recoveryStrategy !== 'demand_full' && !d.setupLinkUrl)
    return {
      text: 'Automated reminders ON — but nothing sends until a re-signup link is added below',
      tone: 'warn',
    }
  return {
    text: `On the automated reminder system — step ${d.escalationStep + 1}${
      d.nextAutoMessageAt ? ` · next message ${formatDate(d.nextAutoMessageAt)}` : ' · scheduling'
    }`,
    tone: 'on',
  }
}

const STATUS_BANNER_CLS: Record<'on' | 'off' | 'warn', string> = {
  on: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  off: 'border-neutral-200 bg-neutral-50 text-neutral-600',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
}

/** Read-only automation + status summary for staff who cannot write (the send
 *  + control panels are hidden for them, but they should still see whether the
 *  person is on the reminder system). */
function ReadonlyAutomationSummary({ detail: d }: { detail: Detail }) {
  const line = automationStatusLine(d)
  return (
    <section className={`rounded-lg border p-3 ${STATUS_BANNER_CLS[line.tone]}`}>
      <p className="text-sm font-medium">{line.text}</p>
      <p className="mt-0.5 text-xs opacity-80">
        {d.messages.length} message{d.messages.length === 1 ? '' : 's'} sent · outstanding{' '}
        {formatMoneyMinor(d.outstandingMinor)}
      </p>
    </section>
  )
}

export function CaseDetailModal({
  caseId,
  canWrite,
  onClose,
}: {
  caseId: string
  canWrite: boolean
  onClose: () => void
}) {
  const utils = trpc.useUtils()
  const detail = trpc.finance.directDebit.cases.caseDetail.useQuery({ caseId })

  const refresh = () => {
    void utils.finance.directDebit.cases.caseDetail.invalidate({ caseId })
    void utils.finance.directDebit.cases.chaseList.invalidate()
  }

  const d = detail.data

  return (
    <Modal open onClose={onClose} size="xl" title={d ? d.name : 'Recovery case'}>
      {detail.isLoading ? (
        <p className="py-8 text-center text-sm text-neutral-500">Loading…</p>
      ) : detail.isError || !d ? (
        <div className="py-8 text-center">
          <p className="text-sm text-red-700">
            {detail.error?.message ?? 'Could not load this recovery case.'}
          </p>
          <button
            type="button"
            className="mt-3 text-sm font-medium text-primary-700 hover:underline"
            onClick={() => void detail.refetch()}
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="space-y-5">
          <HeaderRow detail={d} />
          {/* Automation first (turn reminders on/off), then the manual composer,
              then the full history — matching how an agent works a case. */}
          {canWrite ? (
            <AutomaticRecoveryPanel detail={d} onChange={refresh} />
          ) : (
            <ReadonlyAutomationSummary detail={d} />
          )}
          {canWrite ? <SendPanel detail={d} onSent={refresh} /> : null}
          <HistoryPanel messages={d.messages} />
        </div>
      )}
    </Modal>
  )
}

function HeaderRow({ detail: d }: { detail: Detail }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-base font-semibold text-neutral-900">{d.name}</span>
            <Badge tone={STATUS_TONE[d.status] ?? 'neutral'}>
              {STATUS_LABEL[d.status] ?? d.status}
            </Badge>
            {d.contactId ? (
              <Link
                href={`/contacts/${d.contactId}`}
                className="text-xs font-medium text-primary-700 hover:underline"
              >
                open contact
              </Link>
            ) : (
              <Badge tone="neutral">not in CRM</Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-neutral-500">
            {d.chaseEmail ?? 'no email'} · {d.chasePhoneE164 ?? 'no phone'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums text-neutral-900">
            {formatMoneyMinor(d.outstandingMinor)}
          </div>
          <div className="text-xs text-neutral-500">outstanding</div>
        </div>
      </div>
      {d.gcCustomerId ? (
        <div className="mt-2 text-xs">
          <Link
            href={`/direct-debits/customers/${d.gcCustomerId}`}
            className="text-primary-700 hover:underline"
          >
            View GoCardless customer →
          </Link>
        </div>
      ) : null}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Send a message now (manual, human-confirmed).
// -----------------------------------------------------------------------------

function SendPanel({ detail: d, onSent }: { detail: Detail; onSent: () => void }) {
  const [channel, setChannel] = useState<Channel>('email')
  const [templateId, setTemplateId] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  const templates = trpc.ddRecoveryTemplate.pickList.useQuery(undefined)
  const send = trpc.finance.directDebit.cases.sendCaseMessage.useMutation({
    onSuccess: () => {
      toast.success(channel === 'email' ? 'Recovery email sent' : 'Recovery SMS sent')
      setTemplateId('')
      setSubject('')
      setBody('')
      onSent()
    },
    onError: (e) => toast.error(e.message),
  })
  const refine = trpc.finance.directDebit.cases.draftMessage.useMutation({
    onSuccess: (r) => {
      setBody(r.text)
      toast.success('Personalised with AI — please review before sending.')
    },
    onError: (e) => toast.error(e.message),
  })

  // Server-computed token values — name, amount, re-signup link, and the
  // calculated CCJ court fee + interest — the SAME set the automated engine
  // uses, so the preview matches what actually goes out.
  const vars = d.templateVars
  const visible = (templates.data ?? []).filter((t) =>
    channel === 'email' ? t.channel === 'email' : t.channel === 'sms' || t.channel === 'trengo',
  )
  const chosen = visible.find((t) => t.id === templateId)
  const hasEmail = Boolean(d.chaseEmail)
  const hasPhone = Boolean(d.chasePhoneE164 && d.chasePhoneE164.startsWith('+'))

  function pickChannel(next: Channel) {
    setChannel(next)
    setTemplateId('')
    setSubject('')
    setBody('')
  }

  function applyTemplate(id: string) {
    setTemplateId(id)
    const t = visible.find((x) => x.id === id)
    if (!t) return
    if (channel === 'email') setSubject(renderRecoveryTemplate(t.subject ?? '', vars))
    setBody(renderRecoveryTemplate(t.body, vars))
  }

  function submit() {
    if (channel === 'email' && !subject.trim()) {
      toast.error('Subject is required')
      return
    }
    if (!body.trim()) {
      toast.error('Message is required')
      return
    }
    send.mutate({
      caseId: d.id,
      channel,
      templateId: templateId || null,
      subject: channel === 'email' ? subject : undefined,
      body,
    })
  }

  return (
    <section className="rounded-lg border border-neutral-200 p-3">
      <h3 className="text-sm font-semibold text-neutral-900">Send a message now</h3>
      <p className="mt-0.5 text-xs text-neutral-500">
        Pick a template, review and edit, then send. Goes out from the system mailbox (email) or
        Trengo (SMS){d.contactId ? ' and is logged on their timeline' : ''}.
      </p>
      <p className="mt-1 rounded bg-neutral-50 px-2 py-1 text-[11px] text-neutral-600">
        If it goes to court, the CCJ templates auto-fill: court fee{' '}
        <span className="font-medium">{formatMoneyMinor(d.ccj.courtFeeMinor)}</span> + interest{' '}
        <span className="font-medium">{formatMoneyMinor(d.ccj.interestMinor)}</span>
        {d.ccj.lateFeeMinor > 0 ? (
          <>
            {' '}
            + late fee <span className="font-medium">{formatMoneyMinor(d.ccj.lateFeeMinor)}</span>
          </>
        ) : null}{' '}
        → total owed <span className="font-medium">{formatMoneyMinor(d.ccj.totalMinor)}</span>.
      </p>

      <div className="mt-2 inline-flex rounded-md border border-neutral-200 p-0.5 text-sm">
        {(['email', 'sms'] as Channel[]).map((c) => (
          <button
            key={c}
            type="button"
            className={`rounded px-3 py-1 ${
              channel === c ? 'bg-neutral-900 text-white' : 'text-neutral-600'
            }`}
            onClick={() => pickChannel(c)}
          >
            {c === 'email' ? 'Email' : 'SMS'}
          </button>
        ))}
      </div>

      {(channel === 'email' && !hasEmail) || (channel === 'sms' && !hasPhone) ? (
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {channel === 'email'
            ? 'No email on this case — add one in Automatic recovery below.'
            : 'No usable phone (+…) on this case — add one in Automatic recovery below.'}
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          <Field label="Template" htmlFor="case-send-template">
            <select
              id="case-send-template"
              className="h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm"
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
            >
              <option value="">Choose a template…</option>
              {visible.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.kind === 'legal_escalation' ? '⚖ ' : ''}
                  {t.name}
                </option>
              ))}
            </select>
            {templates.data && visible.length === 0 ? (
              <span className="text-xs text-neutral-500">
                No {channel === 'email' ? 'email' : 'SMS'} templates yet — add them in Settings →
                Direct Debit recovery templates.
              </span>
            ) : null}
          </Field>
          {channel === 'email' ? (
            <Field label="Subject" htmlFor="case-send-subject">
              <Input
                id="case-send-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </Field>
          ) : null}
          <Field label="Message" htmlFor="case-send-body">
            <textarea
              id="case-send-body"
              className="min-h-[160px] w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
          {channel === 'email' && chosen?.kind === 'legal_escalation' ? (
            <p className="text-xs text-neutral-600">
              A PDF copy of this letter is attached automatically
              {chosen.pdfFileName ? (
                <>
                  , plus <span className="font-medium">{chosen.pdfFileName}</span>
                </>
              ) : null}
              .
            </p>
          ) : channel === 'email' && chosen?.pdfFileName ? (
            <p className="text-xs text-neutral-600">
              Attaches <span className="font-medium">{chosen.pdfFileName}</span> to this email.
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={refine.isPending || send.isPending || !body.trim()}
              onClick={() => refine.mutate({ caseId: d.id, channel, body })}
              title="Personalise this draft for the customer, keeping all figures and links"
            >
              {refine.isPending ? 'Refining…' : 'Refine with AI'}
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={send.isPending}>
              {send.isPending ? 'Sending…' : channel === 'email' ? 'Send email' : 'Send SMS'}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

// -----------------------------------------------------------------------------
// Automatic recovery controls (the escalating chase).
// -----------------------------------------------------------------------------

function AutomaticRecoveryPanel({ detail: d, onChange }: { detail: Detail; onChange: () => void }) {
  const [email, setEmail] = useState(d.chaseEmail ?? '')
  const [phone, setPhone] = useState(d.chasePhoneE164 ?? '')
  const [link, setLink] = useState(d.setupLinkUrl ?? '')

  useEffect(() => {
    setEmail(d.chaseEmail ?? '')
    setPhone(d.chasePhoneE164 ?? '')
    setLink(d.setupLinkUrl ?? '')
  }, [d.chaseEmail, d.chasePhoneE164, d.setupLinkUrl])

  const update = trpc.finance.directDebit.cases.updateChase.useMutation({
    onSuccess: () => onChange(),
    onError: (e) => toast.error(e.message),
  })
  const markUpToDate = trpc.finance.directDebit.cases.markUpToDate.useMutation({
    onSuccess: () => {
      toast.success('Marked up to date — automated messages stopped.')
      onChange()
    },
    onError: (e) => toast.error(e.message),
  })

  const busy = update.isPending || markUpToDate.isPending
  const open = d.status === 'new' || d.status === 'chasing' || d.status === 'escalated'
  const statusLine = automationStatusLine(d)

  return (
    <section className="rounded-lg border border-neutral-200 p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">Automated reminders</h3>
        {open ? (
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant={d.autoChase ? 'secondary' : 'default'}
              disabled={busy}
              onClick={() => update.mutate({ caseId: d.id, autoChase: !d.autoChase })}
            >
              {d.autoChase ? 'Turn reminders OFF' : 'Turn reminders ON'}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => markUpToDate.mutate({ caseId: d.id })}
            >
              Mark up to date
            </Button>
          </div>
        ) : null}
      </div>

      {/* The at-a-glance answer to "are they on the automated system?" */}
      <p
        className={`mt-2 rounded-md border px-3 py-2 text-sm font-medium ${STATUS_BANNER_CLS[statusLine.tone]}`}
      >
        {statusLine.text}
      </p>

      <p className="mt-2 text-xs text-neutral-500">
        When on, the escalating chase sends each enabled channel a more-serious message every{' '}
        {d.cadenceDays} day{d.cadenceDays === 1 ? '' : 's'} until they pay
        {d.recoveryStrategy === 'demand_full' ? ' in full' : ' or set the Direct Debit back up'}.
      </p>

      {/* Recovery goal: get them back on a plan (send the sign-up link) vs
          demand the full outstanding balance now. Drives whether a re-signup
          link is required before reminders can send. */}
      <div className="mt-3">
        <div className="text-xs font-medium text-neutral-700">What are we asking them to do?</div>
        <div className="mt-1 inline-flex rounded-md border border-neutral-200 p-0.5 text-xs">
          {(
            [
              ['resend_link', 'Sign up to a plan again'],
              ['demand_full', 'Pay the full amount now'],
            ] as const
          ).map(([value, label]) => {
            const active = (d.recoveryStrategy ?? 'resend_link') === value
            return (
              <button
                key={value}
                type="button"
                disabled={busy || !open}
                className={`rounded px-3 py-1 ${
                  active ? 'bg-neutral-900 text-white' : 'text-neutral-600'
                } disabled:opacity-50`}
                onClick={() => update.mutate({ caseId: d.id, recoveryStrategy: value })}
              >
                {label}
              </button>
            )
          })}
        </div>
        <p className="mt-1 text-[11px] text-neutral-500">
          {d.recoveryStrategy === 'demand_full'
            ? 'Chases for the full outstanding balance — no re-signup link needed.'
            : 'Chases them back onto a Direct Debit / payment plan — paste the re-signup link below before reminders send.'}
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-neutral-600">
          Email
          <div className="mt-1 flex gap-1">
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="h-8 text-xs"
              disabled={!open}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || !open}
              onClick={() => update.mutate({ caseId: d.id, chaseEmail: email.trim() || null })}
            >
              Save
            </Button>
          </div>
        </label>
        <label className="text-xs text-neutral-600">
          Phone (E.164, +…)
          <div className="mt-1 flex gap-1">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+447…"
              className="h-8 text-xs"
              disabled={!open}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || !open}
              onClick={() => update.mutate({ caseId: d.id, chasePhoneE164: phone.trim() || null })}
            >
              Save
            </Button>
          </div>
        </label>
      </div>

      <label className="mt-3 block text-xs text-neutral-600">
        {d.recoveryStrategy === 'demand_full'
          ? 'Re-signup link (GoCardless or Stripe) — optional; add one if you also want to offer a plan'
          : 'Re-signup link (GoCardless or Stripe) — messages only start once this is set'}
        <div className="mt-1 flex gap-1">
          <Input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://…"
            className="h-8 text-xs"
            disabled={!open}
          />
          <Button
            type="button"
            size="sm"
            disabled={busy || !open}
            onClick={() => update.mutate({ caseId: d.id, setupLinkUrl: link.trim() || null })}
          >
            Save
          </Button>
        </div>
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <ChannelToggle
          label="Auto emails"
          on={d.sendEmails}
          disabled={!open || busy}
          onToggle={() => update.mutate({ caseId: d.id, sendEmails: !d.sendEmails })}
        />
        <ChannelToggle
          label="Auto texts"
          on={d.sendTexts}
          disabled={!open || busy}
          onToggle={() => update.mutate({ caseId: d.id, sendTexts: !d.sendTexts })}
        />
        <span className="ml-auto text-xs text-neutral-500">
          {d.status === 'recovered'
            ? 'Recovered'
            : d.status === 'written_off'
              ? 'Written off'
              : !d.autoChase
                ? 'Paused'
                : d.setupLinkUrl
                  ? `Step ${d.escalationStep} · ${
                      d.nextAutoMessageAt ? `next ${formatDate(d.nextAutoMessageAt)}` : 'scheduling'
                    }`
                  : 'Needs re-signup link'}
        </span>
      </div>
    </section>
  )
}

function ChannelToggle({
  label,
  on,
  disabled,
  onToggle,
}: {
  label: string
  on: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      className={
        on
          ? 'rounded-full bg-primary-100 px-2.5 py-1 text-xs font-medium text-primary-800 disabled:opacity-50'
          : 'rounded-full bg-neutral-100 px-2.5 py-1 text-xs font-medium text-neutral-500 disabled:opacity-50'
      }
    >
      {label} {on ? 'on' : 'off'}
    </button>
  )
}

// -----------------------------------------------------------------------------
// Communication history (auto + manual).
// -----------------------------------------------------------------------------

function HistoryPanel({ messages }: { messages: Detail['messages'] }) {
  return (
    <section className="rounded-lg border border-neutral-200 p-3">
      <h3 className="text-sm font-semibold text-neutral-900">
        Communication history{messages.length > 0 ? ` (${messages.length})` : ''}
      </h3>
      {messages.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">Nothing sent yet.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {messages.map((m) => (
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
      )}
    </section>
  )
}
