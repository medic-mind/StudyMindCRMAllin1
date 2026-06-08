// Two-step call-summary workflow on a contact:
//   Step 1 — compose the customer-facing summary (templates you can edit + AI
//            draft) and send it to the customer over WhatsApp / SMS / Email
//            (any combination). Email auto-attaches what you pick; the app
//            handles formatting + threading.
//   Step 2 — once the customer message is away, the agent is prompted for a
//            SEPARATE internal note (what happened + next steps / VA
//            instructions). It's saved to the CRM as internal-only and can be
//            posted to a chosen Slack channel and/or opened as a VA task.
// CLAUDE.md §10, §11, §12, §26.

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

/** Read a File as a base64 string (no data-URL prefix) for the upload payload. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

export function CallSummarySection({ contactId, contactDisplayName }: Props) {
  const router = useRouter()

  // ── Step 1: customer-facing summary ──────────────────────────────
  const [body, setBody] = useState('')
  const [outcome, setOutcome] = useState<Outcome>('answered')
  const [whatsapp, setWhatsapp] = useState(false)
  const [sms, setSms] = useState(false)
  const [email, setEmail] = useState(false)
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [pickedAttachments, setPickedAttachments] = useState<
    Array<{ kind: AttachmentKind; id: string }>
  >([])
  // Files uploaded straight from the agent's device (base64) — separate from
  // the saved library files above. Email channel only.
  const [uploadedFiles, setUploadedFiles] = useState<
    Array<{ filename: string; contentType: string; dataBase64: string; size: number }>
  >([])
  const [drafting, setDrafting] = useState(false)

  // ── Step 2: internal note (revealed once step 1 is done) ─────────
  const [summaryId, setSummaryId] = useState<string | null>(null)
  const [internalNote, setInternalNote] = useState('')
  const [postToSlack, setPostToSlack] = useState(false)
  const [slackChannelId, setSlackChannelId] = useState('')
  const [createTask, setCreateTask] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskAssigneeId, setTaskAssigneeId] = useState('')
  const [taskDueAt, setTaskDueAt] = useState('')

  const [busy, setBusy] = useState(false)

  const add = trpc.contact.callSummary.add.useMutation()
  const send = trpc.contact.callSummary.send.useMutation()
  const logInternal = trpc.contact.callSummary.logInternal.useMutation()
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

  async function onPickFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const next: Array<{ filename: string; contentType: string; dataBase64: string; size: number }> = []
    for (const file of Array.from(files)) {
      if (file.size > 8 * 1024 * 1024) {
        toast.error(`"${file.name}" is over the 8 MB limit.`)
        continue
      }
      const dataBase64 = await fileToBase64(file)
      next.push({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        dataBase64,
        size: file.size,
      })
    }
    if (next.length > 0) setUploadedFiles((prev) => [...prev, ...next].slice(0, 10))
  }
  function removeUpload(idx: number) {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== idx))
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
      toast.success('AI draft ready — edit before sending.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not draft from call')
    } finally {
      setDrafting(false)
    }
  }

  function resetAll() {
    setBody('')
    setOutcome('answered')
    setWhatsapp(false)
    setSms(false)
    setEmail(false)
    setActiveTemplateId(null)
    setPickedAttachments([])
    setUploadedFiles([])
    setSummaryId(null)
    setInternalNote('')
    setPostToSlack(false)
    setSlackChannelId('')
    setCreateTask(false)
    setTaskTitle('')
    setTaskAssigneeId('')
    setTaskDueAt('')
  }

  // Step 1 — save the summary, send to the chosen customer channels, then
  // advance to the internal-note step. `alsoSend=false` records the summary
  // without messaging the customer (still advances to step 2).
  async function submitStep1(alsoSend: boolean) {
    if (!body.trim()) {
      toast.error('Add some text first.')
      return
    }
    setBusy(true)
    try {
      const created = await add.mutateAsync({ contactId, body, outcome })

      if (alsoSend && (whatsapp || sms || email)) {
        const results = await send.mutateAsync({
          summaryInteractionId: created.id,
          channels: { whatsapp, sms, email },
          emailAttachments:
            email && pickedAttachments.length > 0 ? pickedAttachments : undefined,
          uploadedAttachments:
            email && uploadedFiles.length > 0
              ? uploadedFiles.map((f) => ({
                  filename: f.filename,
                  contentType: f.contentType,
                  dataBase64: f.dataBase64,
                }))
              : undefined,
        })
        const parts: string[] = []
        for (const k of ['whatsapp', 'sms', 'email'] as const) {
          const r = results[k]
          if (!r) continue
          if (r.status === 'sent') parts.push(`${k} ✓`)
          else if (r.status === 'skipped')
            parts.push(`${k} skipped${r.detail ? ` (${r.detail})` : ''}`)
          else parts.push(`${k} failed${r.detail ? ` (${r.detail})` : ''}`)
        }
        toast(parts.length ? parts.join(' · ') : 'Summary saved')
      } else {
        toast.success('Call summary saved')
      }

      // Advance to step 2. Prefill the internal note with the summary so the
      // agent only has to append next steps / VA instructions.
      setSummaryId(created.id)
      setInternalNote(body.trim())
      setTaskTitle(`Follow up: ${contactDisplayName}`)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  // Step 2 — log the internal note, optionally post to Slack + open a VA task.
  async function submitStep2() {
    if (!internalNote.trim()) {
      toast.error('Add an internal note first.')
      return
    }
    if (createTask && !taskAssigneeId) {
      toast.error('Pick who the task is for.')
      return
    }
    setBusy(true)
    try {
      const res = await logInternal.mutateAsync({
        contactId,
        note: internalNote,
        postToSlack,
        slackChannelId:
          postToSlack && effectiveSlackChannelId ? effectiveSlackChannelId : undefined,
      })
      toast.success('Internal note saved')
      if (postToSlack && res.slack) {
        if (res.slack.status === 'sent') toast('Slack ✓')
        else toast(`Slack ${res.slack.status}${res.slack.detail ? ` (${res.slack.detail})` : ''}`)
      }

      if (createTask && taskAssigneeId) {
        try {
          await taskCreate.mutateAsync({
            title: taskTitle.trim() || `Follow up: ${contactDisplayName}`,
            description: internalNote.trim(),
            contactId,
            assigneeId: taskAssigneeId,
            dueAt: taskDueAt ? new Date(taskDueAt) : undefined,
          })
          toast.success('Task created')
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Could not create task')
        }
      }

      resetAll()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the note')
    } finally {
      setBusy(false)
    }
  }

  // ── Step 2 view ──────────────────────────────────────────────────
  if (summaryId) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2">
          <span aria-hidden className="text-emerald-700">
            ✓
          </span>
          <p className="text-sm text-emerald-900">
            Step 1 done — the customer summary is saved
            {whatsapp || sms || email ? ' and sent' : ''}. Now log the internal note.
          </p>
        </div>

        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
          <div className="flex items-center gap-2">
            <span aria-hidden className="text-amber-700">
              🔒
            </span>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
              Step 2 — Internal note &amp; next steps
            </p>
          </div>
          <p className="mt-0.5 text-xs text-amber-900/70">
            Not seen by the customer. What happened, and what the team / VA needs to do next.
          </p>

          <Textarea
            className="mt-2"
            rows={5}
            value={internalNote}
            onChange={(e) => setInternalNote(e.target.value)}
            placeholder="What happened on the call, plus next steps / instructions for the VA team…"
          />

          <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-amber-600 focus:ring-amber-500"
              checked={postToSlack}
              onChange={(e) => setPostToSlack(e.target.checked)}
            />
            Post this note to Slack
          </label>

          {postToSlack ? (
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
              onChange={(e) => setCreateTask(e.target.checked)}
            />
            Also open a follow-up task for a VA
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
          <Button type="button" onClick={submitStep2} disabled={busy || !internalNote.trim()}>
            {busy ? 'Saving…' : 'Save internal note'}
          </Button>
          <Button type="button" variant="secondary" onClick={resetAll} disabled={busy}>
            Skip &amp; log another call
          </Button>
        </div>
      </div>
    )
  }

  // ── Step 1 view ──────────────────────────────────────────────────
  const nothingChosen = !whatsapp && !sms && !email

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

      {/* The customer-facing summary */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem]">
        <Textarea
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`What to send ${contactDisplayName} after the call…`}
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

      {/* Step 1: send to the customer */}
      <div className="rounded-lg border border-primary-200 bg-primary-50/40 p-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className="text-primary-700">
            👤
          </span>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary-900">
            Step 1 — Send to the customer
          </p>
        </div>
        <p className="mt-0.5 text-xs text-primary-900/70">
          {contactDisplayName} will receive this. Pick one or more channels.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              checked={whatsapp}
              onChange={(e) => setWhatsapp(e.target.checked)}
            />
            WhatsApp
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              checked={sms}
              onChange={(e) => setSms(e.target.checked)}
            />
            SMS
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              checked={email}
              onChange={(e) => setEmail(e.target.checked)}
            />
            Email
          </label>
        </div>
        <p className="mt-1 text-[11px] text-primary-900/60">
          WhatsApp &amp; SMS go via Trengo (continuing their thread, or starting one to their
          number). Email replies on the latest Gmail thread.
        </p>

        {email ? (
          <div className="mt-3 border-t border-primary-200/60 pt-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-900/80">
              Attach to the email ({pickedAttachments.length + uploadedFiles.length})
            </p>

            {/* Upload a file straight from your device — always available. */}
            <div className="mt-1.5">
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-primary-300 bg-white px-2.5 py-1 text-xs font-medium text-primary-700 transition-colors hover:bg-primary-50">
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => {
                    void onPickFiles(e.target.files)
                    e.currentTarget.value = ''
                  }}
                />
                Upload a file…
              </label>
              {uploadedFiles.length > 0 ? (
                <ul className="mt-1.5 space-y-1">
                  {uploadedFiles.map((f, i) => (
                    <li
                      key={`${f.filename}:${i}`}
                      className="flex items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate text-neutral-700">{f.filename}</span>
                      <span className="shrink-0 font-mono text-[10px] text-neutral-400">
                        {Math.max(1, Math.round(f.size / 1024))} KB
                      </span>
                      <button
                        type="button"
                        onClick={() => removeUpload(i)}
                        aria-label={`Remove ${f.filename}`}
                        className="shrink-0 px-1 text-neutral-400 hover:text-neutral-700"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>

            {/* Or pick a file already saved against this contact. */}
            {attachmentChoices.length > 0 ? (
              <>
                <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                  Or attach a saved file
                </p>
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
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={() => submitStep1(true)}
          disabled={busy || !body.trim() || nothingChosen}
        >
          {busy ? 'Sending…' : 'Send to customer →'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => submitStep1(false)}
          disabled={busy || !body.trim()}
        >
          Save without sending →
        </Button>
      </div>

      <p className="text-[11px] text-neutral-500">
        Each channel is best-effort and independent — one failing channel never aborts the
        others. After this you&apos;ll add an internal note for the team.
      </p>
    </div>
  )
}
