// Write a call summary against a contact and route it in one place. The send
// step is split into two clearly-labelled groups so the agent always knows
// what reaches the family vs what stays internal:
//   1. "Send to the customer" — Trengo / Email (with prefilled attachments).
//   2. "Internal — Slack & action points" — post to a configurable Slack
//      channel for the VAs, and optionally open a follow-up Task on the
//      customer assigned to a VA.
// Mirrors the card.callSummary flow on boards but works directly against the
// contact. CLAUDE.md §10, §11, §12, §26.

'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

type Outcome = 'answered' | 'voicemail' | 'no_answer'

interface DbTemplate {
  id: string
  name: string
  body: string
  hasPdf: boolean
  pdfFileName: string | null
}

type AttachmentKind = 'contactDocument' | 'uploadedInvoice' | 'callSummaryTemplatePdf'
interface AttachmentChoice {
  kind: AttachmentKind
  id: string
  label: string
  hint?: string
}

interface Props {
  contactId: string
  contactDisplayName: string
}

export function CallSummarySection({ contactId, contactDisplayName }: Props) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [outcome, setOutcome] = useState<Outcome>('answered')
  const [trengo, setTrengo] = useState(false)
  const [email, setEmail] = useState(false)
  const [slack, setSlack] = useState(false)
  const [slackChannelId, setSlackChannelId] = useState('')
  const [busy, setBusy] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [pickedAttachments, setPickedAttachments] = useState<
    Array<{ kind: AttachmentKind; id: string }>
  >([])

  // Create-task sub-form (internal action point for a VA).
  const [createTask, setCreateTask] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskAssigneeId, setTaskAssigneeId] = useState('')
  const [taskDueAt, setTaskDueAt] = useState('')

  const add = trpc.contact.callSummary.add.useMutation()
  const send = trpc.contact.callSummary.send.useMutation()
  const taskCreate = trpc.task.create.useMutation()
  const utils = trpc.useUtils()

  const templatesQuery = trpc.callSummaryTemplate.pickList.useQuery()
  const templates: DbTemplate[] = templatesQuery.data ?? []
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? null

  const slackChannelsQuery = trpc.slackChannel.pickList.useQuery()
  const slackChannels = slackChannelsQuery.data ?? []
  const defaultSlackChannelId = useMemo(
    () => slackChannels.find((c) => c.isDefault)?.channelId ?? slackChannels[0]?.channelId ?? '',
    [slackChannels],
  )
  const effectiveSlackChannelId = slackChannelId || defaultSlackChannelId

  const vaQuery = trpc.task.assignableUsers.useQuery({})
  const assignableUsers = vaQuery.data ?? []

  // Attachment sources — only fetched once Email is chosen.
  const documentsQuery = trpc.contact.documents.list.useQuery(
    { contactId },
    { enabled: email },
  )
  const invoicesQuery = trpc.uploadedInvoice.list.useQuery(
    { contactId, includeArchived: false },
    { enabled: email },
  )
  const attachTemplatesQuery = trpc.callSummaryTemplate.list.useQuery(
    { includeArchived: false },
    { enabled: email },
  )

  const attachmentChoices: AttachmentChoice[] = [
    ...(documentsQuery.data ?? []).map((d) => ({
      kind: 'contactDocument' as const,
      id: d.id,
      label: d.fileName,
      hint: 'Contact document',
    })),
    ...(invoicesQuery.data ?? []).map((i) => ({
      kind: 'uploadedInvoice' as const,
      id: i.id,
      label: i.fileName,
      hint: i.invoiceNumber ? `Invoice #${i.invoiceNumber}` : 'Uploaded invoice',
    })),
    ...(attachTemplatesQuery.data ?? [])
      .filter((t) => t.hasPdf)
      .map((t) => ({
        kind: 'callSummaryTemplatePdf' as const,
        id: t.id,
        label: t.pdfFileName ?? t.name,
        hint: `Template · ${t.name}`,
      })),
  ]

  function isPicked(choice: AttachmentChoice): boolean {
    return pickedAttachments.some((p) => p.kind === choice.kind && p.id === choice.id)
  }
  function toggleAttachment(choice: AttachmentChoice, next: boolean) {
    setPickedAttachments((prev) => {
      const without = prev.filter((p) => !(p.kind === choice.kind && p.id === choice.id))
      return next ? [...without, { kind: choice.kind, id: choice.id }] : without
    })
  }

  function pickTemplate(t: DbTemplate) {
    setBody(t.body)
    setActiveTemplateId(t.id)
  }

  async function draftFromCall() {
    setDrafting(true)
    try {
      const result = await utils.contact.callSummary.draftFromCall.fetch({ contactId })
      if (result.status === 'no_call') {
        toast('No calls recorded for this contact yet.')
        return
      }
      if (result.status === 'no_transcript') {
        toast(
          'Latest call has no transcript yet. Enable Aircall AI Assist or wait for Whisper to finish.',
        )
        return
      }
      setBody(result.text)
      if (result.outcomeHint) setOutcome(result.outcomeHint as Outcome)
      toast.success('AI draft ready — edit before saving.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not draft from call')
    } finally {
      setDrafting(false)
    }
  }

  function resetForm() {
    setBody('')
    setTrengo(false)
    setEmail(false)
    setSlack(false)
    setSlackChannelId('')
    setActiveTemplateId(null)
    setPickedAttachments([])
    setCreateTask(false)
    setTaskTitle('')
    setTaskAssigneeId('')
    setTaskDueAt('')
  }

  async function save(alsoSend: boolean) {
    if (!body.trim()) {
      toast.error('Add some text first.')
      return
    }
    if (alsoSend && createTask && !taskAssigneeId) {
      toast.error('Pick who the task is for.')
      return
    }
    setBusy(true)
    try {
      const created = await add.mutateAsync({ contactId, body, outcome })
      toast.success('Call summary saved')

      if (alsoSend && (slack || trengo || email)) {
        const results = await send.mutateAsync({
          summaryInteractionId: created.id,
          channels: { slack, trengo, email },
          slackChannelId: slack && effectiveSlackChannelId ? effectiveSlackChannelId : undefined,
          emailAttachments:
            email && pickedAttachments.length > 0 ? pickedAttachments : undefined,
        })
        const parts: string[] = []
        for (const k of ['trengo', 'email', 'slack'] as const) {
          const r = results[k]
          if (!r) continue
          if (r.status === 'sent') parts.push(`${k} ✓`)
          else if (r.status === 'skipped')
            parts.push(`${k} skipped${r.detail ? ` (${r.detail})` : ''}`)
          else parts.push(`${k} failed${r.detail ? ` (${r.detail})` : ''}`)
        }
        if (parts.length) toast(parts.join(' · '))
      }

      // Internal action point: open a follow-up task on the customer for a VA.
      if (alsoSend && createTask && taskAssigneeId) {
        try {
          await taskCreate.mutateAsync({
            title: taskTitle.trim() || `Follow up: ${contactDisplayName}`,
            description: body.trim(),
            contactId,
            assigneeId: taskAssigneeId,
            dueAt: taskDueAt ? new Date(taskDueAt) : undefined,
          })
          toast.success('Task created')
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Could not create task')
        }
      }

      resetForm()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const nothingToSend = !slack && !trengo && !email && !createTask

  return (
    <div className="space-y-3">
      {/* Quick start: AI draft + template chips */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          Quick start
        </span>
        <button
          type="button"
          onClick={draftFromCall}
          disabled={drafting}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary-300 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-800 transition-colors hover:bg-primary-100 disabled:opacity-50"
        >
          <span aria-hidden="true">✨</span>
          {drafting ? 'Drafting…' : 'AI draft from latest call'}
        </button>
        {templates.map((t) => {
          const active = t.id === activeTemplateId
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => pickTemplate(t)}
              className={
                active
                  ? 'inline-flex items-center gap-1 rounded-full border border-primary-300 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-800'
                  : 'inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700'
              }
            >
              {t.name}
              {t.hasPdf ? (
                <span
                  aria-hidden
                  className="rounded bg-primary-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary-800"
                >
                  PDF
                </span>
              ) : null}
            </button>
          )
        })}
        {templatesQuery.data && templates.length === 0 ? (
          <span className="text-xs text-neutral-500">
            No templates yet — admins can add some at Settings → Call summary templates.
          </span>
        ) : null}
      </div>

      {activeTemplate?.hasPdf ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary-200 bg-primary-50/50 px-3 py-2 text-xs">
          <span className="font-medium text-primary-900">Script for {activeTemplate.name}:</span>
          <a
            href={`/api/call-summary-templates/${activeTemplate.id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-800 hover:underline"
          >
            Open PDF{activeTemplate.pdfFileName ? ` (${activeTemplate.pdfFileName})` : ''}
          </a>
        </div>
      ) : null}

      {/* The summary itself */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem]">
        <Textarea
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Summarise the call with ${contactDisplayName}…`}
        />
        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Outcome
          </label>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
            <option value="answered">Answered</option>
            <option value="voicemail">Voicemail</option>
            <option value="no_answer">No answer</option>
          </Select>
        </div>
      </div>

      {/* ── Group 1: To the customer ─────────────────────────────── */}
      <div className="rounded-lg border border-primary-200 bg-primary-50/40 p-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-primary-700">
            👤
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary-900">
            Send to the customer
          </p>
        </div>
        <p className="mt-0.5 text-xs text-primary-900/70">
          {contactDisplayName} will receive this. Pick how it reaches them.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              checked={trengo}
              onChange={(e) => setTrengo(e.target.checked)}
            />
            Trengo (latest WhatsApp / SMS / email conversation)
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              checked={email}
              onChange={(e) => setEmail(e.target.checked)}
            />
            Email (replies on the latest Gmail thread)
          </label>
        </div>

        {email ? (
          <div className="mt-3 border-t border-primary-200/60 pt-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-900/80">
              Attach to the email ({pickedAttachments.length})
            </p>
            {attachmentChoices.length === 0 ? (
              <p className="mt-1 text-xs text-neutral-500">
                No documents, invoices, or template PDFs available for this contact yet.
              </p>
            ) : (
              <ul className="mt-1 max-h-40 space-y-1 overflow-y-auto pr-1">
                {attachmentChoices.map((c) => (
                  <li key={`${c.kind}:${c.id}`}>
                    <label className="flex items-start gap-2 text-xs text-neutral-700">
                      <input
                        type="checkbox"
                        className="mt-0.5 h-3.5 w-3.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                        checked={isPicked(c)}
                        onChange={(e) => toggleAttachment(c, e.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{c.label}</span>
                        {c.hint && (
                          <span className="block text-[10px] text-neutral-500">{c.hint}</span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>

      {/* ── Group 2: Internal — Slack & action points ────────────── */}
      <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-amber-700">
            🔒
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
            Internal — Slack &amp; action points
          </p>
        </div>
        <p className="mt-0.5 text-xs text-amber-900/70">
          Not seen by the customer. Send to the VA team and optionally open a follow-up task.
        </p>

        <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-neutral-300 text-amber-600 focus:ring-amber-500"
            checked={slack}
            onChange={(e) => setSlack(e.target.checked)}
          />
          Post to Slack
        </label>

        {slack ? (
          slackChannels.length > 0 ? (
            <div className="ml-6 mt-1.5 max-w-sm">
              <Select
                value={effectiveSlackChannelId}
                onChange={(e) => setSlackChannelId(e.target.value)}
                aria-label="Slack channel"
              >
                {slackChannels.map((c) => (
                  <option key={c.id} value={c.channelId}>
                    {c.label}
                    {c.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <p className="ml-6 mt-1 text-[11px] text-amber-900/70">
              No channels configured — posts to the fallback channel. Add channels at
              Settings → Slack channels.
            </p>
          )
        ) : null}

        <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-neutral-300 text-amber-600 focus:ring-amber-500"
            checked={createTask}
            onChange={(e) => {
              setCreateTask(e.target.checked)
              if (e.target.checked && !taskTitle) {
                setTaskTitle(`Follow up: ${contactDisplayName}`)
              }
            }}
          />
          Also create a task for this customer
        </label>

        {createTask ? (
          <div className="ml-6 mt-2 grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                Task title
              </label>
              <Input
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder={`Follow up: ${contactDisplayName}`}
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                Assign to (VA)
              </label>
              <Select
                value={taskAssigneeId}
                onChange={(e) => setTaskAssigneeId(e.target.value)}
                aria-label="Task assignee"
              >
                <option value="">Choose…</option>
                {assignableUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name ?? u.email}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                Due (optional)
              </label>
              <Input
                type="date"
                value={taskDueAt}
                onChange={(e) => setTaskDueAt(e.target.value)}
              />
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => save(false)} disabled={busy || !body.trim()}>
          {busy ? 'Saving…' : 'Save summary'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => save(true)}
          disabled={busy || !body.trim() || nothingToSend}
        >
          Save &amp; send
        </Button>
      </div>

      <p className="text-[11px] text-neutral-500">
        Each channel is best-effort and independent — one failing channel never aborts the
        others. The summary, the per-channel result, and any task all land on this
        contact&apos;s timeline.
      </p>
    </div>
  )
}
