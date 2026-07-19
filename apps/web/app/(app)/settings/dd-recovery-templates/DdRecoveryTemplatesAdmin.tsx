'use client'

// Manage Direct Debit recovery templates (ADR 0038, Phase 3). Create / edit /
// archive staff-authored reminder & legal-escalation copy. Nothing sends here.

import { useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

const KINDS = [
  { value: 'reminder', label: 'Reminder' },
  { value: 'legal_escalation', label: 'Legal escalation' },
  { value: 'other', label: 'Other' },
]
const CHANNELS = [
  { value: 'email', label: 'Email' },
  { value: 'trengo', label: 'Trengo (WhatsApp/SMS)' },
  { value: 'sms', label: 'SMS' },
]

interface Template {
  id: string
  name: string
  kind: string
  channel: string
  subject: string | null
  body: string
  sortOrder: number
  archivedAt: Date | string | null
  pdfFileName: string | null
  pdfByteSize: number | null
}

const EMPTY = {
  id: null as string | null,
  name: '',
  kind: 'reminder',
  channel: 'email',
  subject: '',
  body: '',
  sortOrder: 0,
}

export function DdRecoveryTemplatesAdmin() {
  const utils = trpc.useUtils()
  const list = trpc.ddRecoveryTemplate.list.useQuery({ includeArchived: true })
  const [form, setForm] = useState(EMPTY)
  const editing = form.id !== null

  const invalidate = () => utils.ddRecoveryTemplate.list.invalidate()
  const onErr = (e: { message: string }) => toast.error(e.message)

  const create = trpc.ddRecoveryTemplate.create.useMutation({
    onSuccess: async () => {
      await invalidate()
      toast.success('Template created')
      setForm(EMPTY)
    },
    onError: onErr,
  })
  const update = trpc.ddRecoveryTemplate.update.useMutation({
    onSuccess: async () => {
      await invalidate()
      toast.success('Template saved')
      setForm(EMPTY)
    },
    onError: onErr,
  })
  const archive = trpc.ddRecoveryTemplate.archive.useMutation({ onSuccess: invalidate, onError: onErr })
  const restore = trpc.ddRecoveryTemplate.restore.useMutation({ onSuccess: invalidate, onError: onErr })
  const attachPdf = trpc.ddRecoveryTemplate.attachPdf.useMutation({
    onSuccess: async () => {
      await invalidate()
      toast.success('PDF attached')
    },
    onError: onErr,
  })
  const removePdf = trpc.ddRecoveryTemplate.removePdf.useMutation({
    onSuccess: async () => {
      await invalidate()
      toast.success('PDF removed')
    },
    onError: onErr,
  })

  async function onPickPdf(id: string, file: File) {
    if (file.type !== 'application/pdf') {
      toast.error('Please choose a PDF file.')
      return
    }
    const buf = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!)
    attachPdf.mutate({ id, fileName: file.name, dataBase64: btoa(binary) })
  }

  const busy = create.isPending || update.isPending

  function submit() {
    const payload = {
      name: form.name.trim(),
      kind: form.kind as 'reminder' | 'legal_escalation' | 'other',
      channel: form.channel as 'email' | 'trengo' | 'sms',
      subject: form.channel === 'email' ? form.subject.trim() || null : null,
      body: form.body,
      sortOrder: form.sortOrder,
    }
    if (!payload.name) {
      toast.error('Name is required')
      return
    }
    if (editing && form.id) update.mutate({ id: form.id, ...payload })
    else create.mutate(payload)
  }

  const templates = (list.data ?? []) as Template[]

  return (
    <div className="space-y-6">
      <RecoverySettingsPanel />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
      <Card>
        <CardHeader>
          <CardTitle>{editing ? 'Edit template' : 'New template'}</CardTitle>
        </CardHeader>
        <CardBody className="space-y-3">
          <Field label="Name" htmlFor="t-name">
            <Input
              id="t-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Reminder 1 / Final notice"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind" htmlFor="t-kind">
              <select
                id="t-kind"
                className="h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm"
                value={form.kind}
                onChange={(e) => setForm({ ...form, kind: e.target.value })}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Channel" htmlFor="t-channel">
              <select
                id="t-channel"
                className="h-9 w-full rounded-md border border-neutral-200 bg-white px-2 text-sm"
                value={form.channel}
                onChange={(e) => setForm({ ...form, channel: e.target.value })}
              >
                {CHANNELS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          {form.channel === 'email' ? (
            <Field label="Subject" htmlFor="t-subject">
              <Input
                id="t-subject"
                value={form.subject}
                onChange={(e) => setForm({ ...form, subject: e.target.value })}
                placeholder="Your Direct Debit plan with StudyMind"
              />
            </Field>
          ) : null}
          <Field
            label="Body"
            htmlFor="t-body"
            hint="Your copy. Tokens: {{first_name}} {{full_name}} {{amount_due}} {{setup_link}} {{phone}}. Court-action tokens (auto-calculated, use on the stern/CCJ steps): {{late_fee}} {{court_fee}} {{interest}} {{daily_interest}} {{total_with_costs}} {{response_deadline}}."
          >
            <textarea
              id="t-body"
              className="min-h-[180px] w-full rounded-md border border-neutral-200 bg-white px-2 py-1.5 text-sm"
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              placeholder="Write your reminder / legal-escalation wording here…"
            />
          </Field>
          <Field
            label="Escalation order"
            htmlFor="t-sort"
            hint="Lower goes out first. The automatic chase walks the sequence, each step more serious."
          >
            <Input
              id="t-sort"
              type="number"
              value={String(form.sortOrder)}
              onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) || 0 })}
              className="w-24"
            />
          </Field>
          <div className="flex justify-end gap-2">
            {editing ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setForm(EMPTY)}>
                Cancel
              </Button>
            ) : null}
            <Button type="button" size="sm" onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : editing ? 'Save changes' : 'Create template'}
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>The message sequence</CardTitle>
        </CardHeader>
        <CardBody className="space-y-5">
          {list.isLoading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : templates.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No templates yet. Create your reminder and legal-escalation copy on the left.
            </p>
          ) : (
            <>
              <p className="text-xs text-neutral-500">
                The chase walks each channel top-to-bottom, one step every few days (see the cadence
                on the left), each more serious than the last.
              </p>
              <TemplateGroup
                title="Email sequence"
                rows={sortByStep(templates.filter((t) => t.channel === 'email'))}
                onEdit={setForm}
                onArchive={(id) => archive.mutate({ id })}
                onRestore={(id) => restore.mutate({ id })}
                onRemovePdf={(id) => removePdf.mutate({ id })}
                onPickPdf={onPickPdf}
              />
              <TemplateGroup
                title="Text sequence (SMS / WhatsApp)"
                rows={sortByStep(templates.filter((t) => t.channel !== 'email'))}
                onEdit={setForm}
                onArchive={(id) => archive.mutate({ id })}
                onRestore={(id) => restore.mutate({ id })}
                onRemovePdf={(id) => removePdf.mutate({ id })}
                onPickPdf={onPickPdf}
              />
            </>
          )}
        </CardBody>
      </Card>
      </div>
    </div>
  )
}

interface SettingsForm {
  lateFeePounds: number
  defaultCadenceDays: number
  responseDays: number
  financePhone: string
  companyName: string
  companyAddress: string
}

// The customisable policy figures behind the chase (ADR 0045 amendment) — late
// fee, cadence, response window, finance phone, and the PDF letterhead. The
// court fee + statutory interest are fixed by law and calculated automatically.
function RecoverySettingsPanel() {
  const utils = trpc.useUtils()
  const q = trpc.ddRecoverySettings.get.useQuery()
  const [f, setF] = useState<SettingsForm | null>(null)

  useEffect(() => {
    if (q.data && f === null) {
      setF({
        lateFeePounds: q.data.lateFeeMinor / 100,
        defaultCadenceDays: q.data.defaultCadenceDays,
        responseDays: q.data.responseDays,
        financePhone: q.data.financePhone,
        companyName: q.data.companyName,
        companyAddress: q.data.companyAddress,
      })
    }
  }, [q.data, f])

  const save = trpc.ddRecoverySettings.update.useMutation({
    onSuccess: async () => {
      await utils.ddRecoverySettings.get.invalidate()
      toast.success('Recovery settings saved')
    },
    onError: (e) => toast.error(e.message),
  })

  if (!f) {
    return (
      <Card>
        <CardBody>
          <p className="text-sm text-neutral-500">Loading recovery settings…</p>
        </CardBody>
      </Card>
    )
  }

  const num = (v: string) => (v === '' ? 0 : Number(v) || 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recovery settings</CardTitle>
      </CardHeader>
      <CardBody className="space-y-3">
        <p className="text-xs text-neutral-500">
          These drive the automatic chase and fill the tokens in the letters. The County Court fee
          and 8% statutory interest are fixed by law and calculated automatically per person — they
          are not set here.
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Late fee (£)" htmlFor="s-late">
            <Input
              id="s-late"
              type="number"
              value={String(f.lateFeePounds)}
              onChange={(e) => setF({ ...f, lateFeePounds: num(e.target.value) })}
            />
          </Field>
          <Field label="Days between steps" htmlFor="s-cad" hint="Default cadence for a new case.">
            <Input
              id="s-cad"
              type="number"
              value={String(f.defaultCadenceDays)}
              onChange={(e) => setF({ ...f, defaultCadenceDays: num(e.target.value) })}
            />
          </Field>
          <Field label="Response window (days)" htmlFor="s-resp" hint="Used for {{response_deadline}}.">
            <Input
              id="s-resp"
              type="number"
              value={String(f.responseDays)}
              onChange={(e) => setF({ ...f, responseDays: num(e.target.value) })}
            />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Finance phone" htmlFor="s-phone">
            <Input
              id="s-phone"
              value={f.financePhone}
              onChange={(e) => setF({ ...f, financePhone: e.target.value })}
            />
          </Field>
          <Field label="Company name (letterhead)" htmlFor="s-cn">
            <Input
              id="s-cn"
              value={f.companyName}
              onChange={(e) => setF({ ...f, companyName: e.target.value })}
            />
          </Field>
          <Field label="Company address (letterhead)" htmlFor="s-ca">
            <Input
              id="s-ca"
              value={f.companyAddress}
              onChange={(e) => setF({ ...f, companyAddress: e.target.value })}
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={() => save.mutate(f)} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </div>
      </CardBody>
    </Card>
  )
}

/** Sort a channel's templates into escalation order (step, then name). */
function sortByStep(rows: Template[]): Template[] {
  return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
}

function TemplateGroup({
  title,
  rows,
  onEdit,
  onArchive,
  onRestore,
  onRemovePdf,
  onPickPdf,
}: {
  title: string
  rows: Template[]
  onEdit: (form: {
    id: string
    name: string
    kind: string
    channel: string
    subject: string
    body: string
    sortOrder: number
  }) => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onRemovePdf: (id: string) => void
  onPickPdf: (id: string, file: File) => void
}) {
  return (
    <section>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-[0.06em] text-neutral-500">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-neutral-400">None yet.</p>
      ) : (
        <ul className="divide-y divide-neutral-100">
          {rows.map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-neutral-900">{t.name}</span>
                  <Badge tone={t.kind === 'legal_escalation' ? 'danger' : 'info'}>
                    {KINDS.find((k) => k.value === t.kind)?.label ?? t.kind}
                  </Badge>
                  {t.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-neutral-500">
                  {t.body || <span className="italic">No copy yet — click Edit to write it.</span>}
                </p>
                {t.channel === 'email' ? (
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    {t.kind === 'legal_escalation' ? (
                      <span className="text-neutral-500">A PDF of this letter is sent automatically.</span>
                    ) : null}
                    {t.pdfFileName ? (
                      <>
                        <a
                          href={`/api/dd-recovery-templates/${t.id}/pdf`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-medium text-primary-700 hover:underline"
                        >
                          {t.pdfFileName}
                        </a>
                        <button
                          type="button"
                          className="text-neutral-500 hover:underline"
                          onClick={() => onRemovePdf(t.id)}
                        >
                          remove PDF
                        </button>
                      </>
                    ) : (
                      <label className="cursor-pointer text-neutral-500 hover:underline">
                        Attach accompanying PDF
                        <input
                          type="file"
                          accept="application/pdf"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0]
                            if (f) void onPickPdf(t.id, f)
                            e.target.value = ''
                          }}
                        />
                      </label>
                    )}
                  </div>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() =>
                    onEdit({
                      id: t.id,
                      name: t.name,
                      kind: t.kind,
                      channel: t.channel,
                      subject: t.subject ?? '',
                      body: t.body,
                      sortOrder: t.sortOrder,
                    })
                  }
                >
                  Edit
                </Button>
                {t.archivedAt ? (
                  <Button type="button" variant="ghost" size="xs" onClick={() => onRestore(t.id)}>
                    Restore
                  </Button>
                ) : (
                  <Button type="button" variant="ghost" size="xs" onClick={() => onArchive(t.id)}>
                    Archive
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
