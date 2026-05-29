// Forwarding rules admin (Manager+). Lists active and archived rules;
// inline-edits a rule's label, recipients, and templates; supports archive +
// restore + create. CLAUDE.md §20.1.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

interface Rule {
  id: string
  key: string
  label: string
  description: string | null
  toAddresses: readonly string[]
  ccAddresses: readonly string[]
  bccAddresses: readonly string[]
  subjectTemplate: string
  bodyTemplate: string
  sortOrder: number
  archived: boolean
}

const HELP_VARS =
  '{{contactName}} · {{contactEmail}} · {{contactPhone}} · {{contactLink}} · {{familyName}} · {{agentName}} · {{notes}}'

export function ForwardingAdmin() {
  const router = useRouter()
  const rulesQuery = trpc.forwarding.rules.list.useQuery({ includeArchived: true })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const rules = rulesQuery.data ?? []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-neutral-600">
          Rules appear in the “Forward to…” dropdown on every contact page.
          Editing a rule changes future sends; rows in the timeline keep the
          subject, body, and recipients used at the time.
        </p>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            New rule
          </Button>
        )}
      </div>

      <p className="text-xs text-neutral-500">
        Template variables: <code className="font-mono text-neutral-700">{HELP_VARS}</code>
      </p>

      {creating && (
        <RuleEditor
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={async () => {
            await rulesQuery.refetch()
            router.refresh()
          }}
        />
      )}

      {rulesQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : rules.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No rules yet. Click <em>New rule</em> to add one.
        </p>
      ) : (
        <ul className="space-y-3">
          {rules.map((r) =>
            editingId === r.id ? (
              <li key={r.id}>
                <RuleEditor
                  mode="edit"
                  rule={r}
                  onClose={() => setEditingId(null)}
                  onSaved={async () => {
                    await rulesQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ) : (
              <li
                key={r.id}
                className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-card"
              >
                <RuleRow
                  rule={r}
                  onEdit={() => setEditingId(r.id)}
                  onChanged={async () => {
                    await rulesQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  )
}

function RuleRow({
  rule,
  onEdit,
  onChanged,
}: {
  rule: Rule
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const archive = trpc.forwarding.rules.archive.useMutation()
  const restore = trpc.forwarding.rules.restore.useMutation()

  async function toggleArchive() {
    try {
      if (rule.archived) {
        await restore.mutateAsync({ id: rule.id })
        toast.success('Rule restored')
      } else {
        await archive.mutateAsync({ id: rule.id })
        toast.success('Rule archived')
      }
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change')
    }
  }

  return (
    <div className="grid grid-cols-1 gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-neutral-900">{rule.label}</h3>
          <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-700">
            {rule.key}
          </code>
          {rule.archived && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
              Archived
            </span>
          )}
        </div>
        {rule.description && (
          <p className="text-xs text-neutral-600">{rule.description}</p>
        )}
        <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-[5rem_minmax(0,1fr)]">
          <dt className="font-medium uppercase tracking-wide text-neutral-500">To</dt>
          <dd className="break-all text-neutral-800">{rule.toAddresses.join(', ')}</dd>
          {rule.ccAddresses.length > 0 && (
            <>
              <dt className="font-medium uppercase tracking-wide text-neutral-500">Cc</dt>
              <dd className="break-all text-neutral-800">{rule.ccAddresses.join(', ')}</dd>
            </>
          )}
          {rule.bccAddresses.length > 0 && (
            <>
              <dt className="font-medium uppercase tracking-wide text-neutral-500">Bcc</dt>
              <dd className="break-all text-neutral-800">{rule.bccAddresses.join(', ')}</dd>
            </>
          )}
          <dt className="font-medium uppercase tracking-wide text-neutral-500">Subject</dt>
          <dd className="break-words font-mono text-[11px] text-neutral-700">
            {rule.subjectTemplate}
          </dd>
        </dl>
      </div>
      <div className="flex flex-wrap items-center gap-2 lg:flex-col lg:items-end">
        <Button type="button" size="sm" variant="secondary" onClick={onEdit}>
          Edit
        </Button>
        <button
          type="button"
          onClick={toggleArchive}
          className="text-xs text-neutral-600 hover:underline"
        >
          {rule.archived ? 'Restore' : 'Archive'}
        </button>
      </div>
    </div>
  )
}

function parseEmails(s: string): string[] {
  return s
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0)
}

function RuleEditor({
  mode,
  rule,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  rule?: Rule
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [key, setKey] = useState(rule?.key ?? '')
  const [label, setLabel] = useState(rule?.label ?? '')
  const [description, setDescription] = useState(rule?.description ?? '')
  const [to, setTo] = useState((rule?.toAddresses ?? []).join(', '))
  const [cc, setCc] = useState((rule?.ccAddresses ?? []).join(', '))
  const [bcc, setBcc] = useState((rule?.bccAddresses ?? []).join(', '))
  const [subject, setSubject] = useState(rule?.subjectTemplate ?? 'Forwarded query: {{contactName}}')
  const [body, setBody] = useState(
    rule?.bodyTemplate ??
      'Hi team,\n\n{{notes}}\n\nContact details:\n- Name: {{contactName}}\n- Email: {{contactEmail}}\n- Phone: {{contactPhone}}\n- CRM link: {{contactLink}}\n\nThanks,\n{{agentName}}',
  )
  const [sortOrder, setSortOrder] = useState(rule?.sortOrder ?? 100)
  const [busy, setBusy] = useState(false)

  const create = trpc.forwarding.rules.create.useMutation()
  const update = trpc.forwarding.rules.update.useMutation()

  async function save() {
    const toAddresses = parseEmails(to)
    const ccAddresses = parseEmails(cc)
    const bccAddresses = parseEmails(bcc)
    if (toAddresses.length === 0) {
      toast.error('Add at least one recipient in “To”')
      return
    }
    if (!label.trim() || !subject.trim() || !body.trim()) {
      toast.error('Label, subject, and body are required')
      return
    }
    setBusy(true)
    try {
      if (mode === 'create') {
        if (!key.trim() || !/^[a-z][a-z0-9_]*$/u.test(key.trim())) {
          toast.error('Key must be lower_snake_case (a-z, 0-9, _)')
          setBusy(false)
          return
        }
        await create.mutateAsync({
          key: key.trim(),
          label: label.trim(),
          description: description.trim() || null,
          toAddresses,
          ccAddresses,
          bccAddresses,
          subjectTemplate: subject.trim(),
          bodyTemplate: body.trim(),
          sortOrder,
        })
        toast.success('Rule created')
      } else if (rule) {
        await update.mutateAsync({
          id: rule.id,
          label: label.trim(),
          description: description.trim() || null,
          toAddresses,
          ccAddresses,
          bccAddresses,
          subjectTemplate: subject.trim(),
          bodyTemplate: body.trim(),
          sortOrder,
        })
        toast.success('Rule updated')
      }
      await onSaved()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/30 p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">
          {mode === 'create' ? 'New forwarding rule' : `Edit: ${rule?.label}`}
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
        <Field label="Label" htmlFor="fwd-label">
          <Input id="fwd-label" value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Key (immutable)" htmlFor="fwd-key">
          <Input
            id="fwd-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            disabled={mode === 'edit'}
            placeholder="e.g. ap_team"
          />
        </Field>
      </div>

      <Field label="Description (optional)" htmlFor="fwd-desc">
        <Input
          id="fwd-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>

      <Field label="To (comma separated)" htmlFor="fwd-to">
        <Input id="fwd-to" value={to} onChange={(e) => setTo(e.target.value)} />
      </Field>

      <Field label="Cc (optional)" htmlFor="fwd-cc">
        <Input id="fwd-cc" value={cc} onChange={(e) => setCc(e.target.value)} />
      </Field>

      <Field label="Bcc (optional)" htmlFor="fwd-bcc">
        <Input id="fwd-bcc" value={bcc} onChange={(e) => setBcc(e.target.value)} />
      </Field>

      <Field label="Subject template" htmlFor="fwd-subject">
        <Input id="fwd-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
      </Field>

      <Field label="Body template" htmlFor="fwd-body">
        <Textarea
          id="fwd-body"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="font-mono text-sm"
        />
      </Field>

      <Field label="Sort order (lower first)" htmlFor="fwd-sort">
        <Input
          id="fwd-sort"
          type="number"
          min={0}
          max={10000}
          value={sortOrder}
          onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
        />
      </Field>

      <p className="text-[11px] text-neutral-500">
        Variables: <code className="font-mono">{HELP_VARS}</code>
      </p>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save rule'}
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

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
      >
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
