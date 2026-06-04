// Call summary section inside the card detail modal (slice B). An agent
// records a call's outcome + notes, saves it (a call_summary Interaction on
// the backing contact), then routes it from a single popover split into two
// clearly-labelled groups:
//   1. "To the customer" — Trengo / Email (with prefilled attachments).
//   2. "Internal — Slack & action points" — post to a configurable Slack
//      channel for the VAs, and optionally open a follow-up Task on the
//      customer assigned to a VA.
// Channels that are not actionable are disabled with a reason. On send we
// surface per-channel success/failure toasts. CLAUDE.md §10, §12, §26, §28, §20.

'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

type Outcome = 'answered' | 'voicemail' | 'no_answer'
type ChannelKey = 'slack' | 'trengo' | 'email'

interface Props {
  cardId: string
  canWrite: boolean
}

const OUTCOME_LABELS: Record<Outcome, string> = {
  answered: 'Answered',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
}

type AttachmentKind = 'contactDocument' | 'uploadedInvoice' | 'callSummaryTemplatePdf'
interface AttachmentChoice {
  kind: AttachmentKind
  id: string
  label: string
  hint?: string
}

export function CallSummarySection({ cardId, canWrite }: Props) {
  const [body, setBody] = useState('')
  const [outcome, setOutcome] = useState<Outcome>('answered')
  const [savedSummaryId, setSavedSummaryId] = useState<string | null>(null)
  const [showSend, setShowSend] = useState(false)
  const [channels, setChannels] = useState<Record<ChannelKey, boolean>>({
    slack: false,
    trengo: true,
    email: false,
  })
  const [slackChannelId, setSlackChannelId] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [pickedAttachments, setPickedAttachments] = useState<
    Array<{ kind: AttachmentKind; id: string }>
  >([])

  // Create-task sub-form (internal action point for a VA).
  const [createTask, setCreateTask] = useState(false)
  const [taskAssigneeId, setTaskAssigneeId] = useState('')

  const cardQuery = trpc.card.get.useQuery({ id: cardId }, { enabled: canWrite })
  const contactId = cardQuery.data?.contactId ?? ''
  const contactName = cardQuery.data?.contactName ?? 'this contact'

  const availability = trpc.card.callSummary.availability.useQuery(
    { cardId },
    { enabled: canWrite },
  )

  const slackChannelsQuery = trpc.slackChannel.pickList.useQuery(undefined, {
    enabled: canWrite && showSend,
  })
  const slackChannels = slackChannelsQuery.data ?? []
  const defaultSlackChannelId = useMemo(
    () => slackChannels.find((c) => c.isDefault)?.channelId ?? slackChannels[0]?.channelId ?? '',
    [slackChannels],
  )
  const effectiveSlackChannelId = slackChannelId || defaultSlackChannelId

  const vaQuery = trpc.task.assignableUsers.useQuery(
    {},
    { enabled: canWrite && showSend },
  )
  const assignableUsers = vaQuery.data ?? []

  // Attachment choices — only relevant when email is enabled in the popover.
  const documentsQuery = trpc.contact.documents.list.useQuery(
    { contactId },
    { enabled: canWrite && showSend && channels.email && Boolean(contactId) },
  )
  const invoicesQuery = trpc.uploadedInvoice.list.useQuery(
    { contactId, includeArchived: false },
    { enabled: canWrite && showSend && channels.email && Boolean(contactId) },
  )
  const templatesQuery = trpc.callSummaryTemplate.list.useQuery(
    { includeArchived: false },
    { enabled: canWrite && showSend && channels.email },
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
    ...(templatesQuery.data ?? [])
      .filter((t) => t.hasPdf)
      .map((t) => ({
        kind: 'callSummaryTemplatePdf' as const,
        id: t.id,
        label: t.pdfFileName ?? t.name,
        hint: `Template · ${t.name}`,
      })),
  ]

  function toggleAttachment(choice: AttachmentChoice, next: boolean) {
    setPickedAttachments((prev) => {
      const without = prev.filter((p) => !(p.kind === choice.kind && p.id === choice.id))
      return next ? [...without, { kind: choice.kind, id: choice.id }] : without
    })
  }
  function isPicked(choice: AttachmentChoice): boolean {
    return pickedAttachments.some((p) => p.kind === choice.kind && p.id === choice.id)
  }

  const utils = trpc.useUtils()

  const previewQuery = trpc.card.callSummary.preview.useQuery(
    { cardId, body: body.trim().length > 0 ? body : 'preview' },
    { enabled: canWrite && showSend && body.trim().length > 0 },
  )

  async function draftFromCall() {
    setDrafting(true)
    try {
      const result = await utils.card.callSummary.draftFromCall.fetch({ cardId })
      if (result.status === 'no_call') {
        toast.message('No calls recorded for this contact yet.')
        return
      }
      if (result.status === 'no_transcript') {
        toast.message(
          'Latest call has no transcript yet. Enable Aircall AI Assist or wait for Whisper to finish.',
        )
        return
      }
      setBody(result.text)
      if (result.outcomeHint) setOutcome(result.outcomeHint as Outcome)
      setSavedSummaryId(null)
      toast.success('AI draft ready — edit before saving.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not draft from call')
    } finally {
      setDrafting(false)
    }
  }

  const add = trpc.card.callSummary.add.useMutation({
    onSuccess: (data) => {
      toast.success('Call summary saved')
      setSavedSummaryId(data?.id ?? null)
    },
    onError: (e) => toast.error(e.message ?? 'Could not save call summary'),
  })

  const send = trpc.card.callSummary.send.useMutation()
  const taskCreate = trpc.task.create.useMutation()
  const [sending, setSending] = useState(false)

  if (!canWrite) return null

  const avail = availability.data
  const slackReason = avail?.slack.available ? undefined : 'No Slack channel configured'
  const trengoReason = avail?.trengo.available
    ? undefined
    : avail?.trengo.hasPhone
      ? 'No Trengo conversation for this contact'
      : 'Contact has no phone number'
  const emailReason = avail?.email.available
    ? undefined
    : !avail?.email.hasEmail
      ? 'Contact has no email address'
      : !avail?.email.gmailConnected
        ? 'No Gmail connected for you'
        : 'No Gmail thread for this contact'

  function channelRow(key: ChannelKey, label: string, reason: string | undefined) {
    const disabled = Boolean(reason)
    return (
      <label
        className={`flex items-center gap-2 text-sm ${disabled ? 'text-neutral-400' : 'text-neutral-800'}`}
        title={reason}
      >
        <input
          type="checkbox"
          checked={!disabled && channels[key]}
          disabled={disabled}
          onChange={(e) => setChannels((c) => ({ ...c, [key]: e.target.checked }))}
        />
        {label}
        {reason ? <span className="text-xs text-neutral-400">({reason})</span> : null}
      </label>
    )
  }

  const anyChannelSelected =
    (!slackReason && channels.slack) ||
    (!trengoReason && channels.trengo) ||
    (!emailReason && channels.email)
  const canConfirm = anyChannelSelected || (createTask && Boolean(taskAssigneeId))

  async function confirmSend() {
    if (!savedSummaryId) return
    setSending(true)
    try {
      if (anyChannelSelected) {
        const results = await send.mutateAsync({
          summaryInteractionId: savedSummaryId,
          channels: {
            slack: !slackReason && channels.slack,
            trengo: !trengoReason && channels.trengo,
            email: !emailReason && channels.email,
          },
          slackChannelId:
            !slackReason && channels.slack && effectiveSlackChannelId
              ? effectiveSlackChannelId
              : undefined,
          emailAttachments:
            !emailReason && channels.email && pickedAttachments.length > 0
              ? pickedAttachments
              : undefined,
        })
        const entries = Object.entries(results ?? {}) as Array<
          [ChannelKey, { status: string; detail?: string }]
        >
        for (const [channel, result] of entries) {
          if (result.status === 'sent') toast.success(`${channel}: sent`)
          else if (result.status === 'failed')
            toast.error(`${channel}: failed${result.detail ? ` — ${result.detail}` : ''}`)
          else toast.message(`${channel}: skipped${result.detail ? ` — ${result.detail}` : ''}`)
        }
      }

      if (createTask && taskAssigneeId && contactId) {
        await taskCreate.mutateAsync({
          title: `Follow up: ${contactName}`,
          description: body.trim() || undefined,
          contactId,
          assigneeId: taskAssigneeId,
        })
        toast.success('Task created')
      }

      setShowSend(false)
      setCreateTask(false)
      setTaskAssigneeId('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send call summary')
    } finally {
      setSending(false)
    }
  }

  return (
    <section>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        Call summary
      </h3>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm text-neutral-700">
          <span className="w-16 shrink-0">Outcome</span>
          <select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as Outcome)}
            className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
            aria-label="Call outcome"
          >
            {(Object.keys(OUTCOME_LABELS) as Outcome[]).map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o]}
              </option>
            ))}
          </select>
        </label>
        <textarea
          rows={3}
          value={body}
          maxLength={4000}
          placeholder="What happened on the call?"
          onChange={(e) => {
            setBody(e.target.value)
            setSavedSummaryId(null)
          }}
          className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
          aria-label="Call summary notes"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={drafting}
            onClick={draftFromCall}
            title="3-4 line summary from the latest Aircall transcript"
          >
            ✨ {drafting ? 'Drafting…' : 'AI draft from call'}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={add.isPending || body.trim().length === 0}
            onClick={() => add.mutate({ cardId, body, outcome })}
          >
            {add.isPending ? 'Saving…' : 'Save summary'}
          </Button>
          {savedSummaryId ? (
            <div className="relative">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowSend((s) => !s)}
                aria-expanded={showSend}
              >
                Send call summary
              </Button>
              {showSend ? (
                <div
                  role="dialog"
                  aria-label="Send call summary"
                  className="absolute z-10 mt-1 w-80 rounded-md border border-neutral-200 bg-white p-3 shadow-lg"
                >
                  {/* Group 1: to the customer */}
                  <div className="rounded-md border border-primary-200 bg-primary-50/40 p-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-900">
                      To the customer
                    </p>
                    <p className="mb-1.5 text-[10px] text-primary-900/70">
                      {contactName} receives this.
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {channelRow('trengo', 'Trengo', trengoReason)}
                      {previewQuery.data?.trengo && !trengoReason ? (
                        <p className="-mt-1 ml-6 text-[10px] text-neutral-500">
                          → {previewQuery.data.trengo.channel} ·{' '}
                          <span className="font-mono">{previewQuery.data.trengo.phoneE164}</span>
                        </p>
                      ) : null}
                      {channelRow('email', 'Email', emailReason)}
                      {previewQuery.data?.email && !emailReason ? (
                        <p className="-mt-1 ml-6 text-[10px] text-neutral-500">
                          →{' '}
                          <span className="font-mono">{previewQuery.data.email.toAddress}</span>{' '}
                          from{' '}
                          <span className="font-mono">{previewQuery.data.email.fromAddress}</span>
                        </p>
                      ) : null}
                    </div>
                    {!emailReason && channels.email && attachmentChoices.length > 0 ? (
                      <div className="mt-2 border-t border-primary-200/60 pt-1.5">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-primary-900/80">
                          Attach to email ({pickedAttachments.length})
                        </p>
                        <ul className="max-h-28 space-y-1 overflow-y-auto pr-1">
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
                                    <span className="block text-[10px] text-neutral-500">
                                      {c.hint}
                                    </span>
                                  )}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>

                  {/* Group 2: internal — Slack & action points */}
                  <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/50 p-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-900">
                      Internal — Slack &amp; action points
                    </p>
                    <p className="mb-1.5 text-[10px] text-amber-900/70">
                      Not seen by the customer.
                    </p>
                    {channelRow('slack', 'Post to Slack', slackReason)}
                    {!slackReason && channels.slack ? (
                      slackChannels.length > 0 ? (
                        <select
                          value={effectiveSlackChannelId}
                          onChange={(e) => setSlackChannelId(e.target.value)}
                          aria-label="Slack channel"
                          className="ml-6 mt-1 w-[calc(100%-1.5rem)] rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
                        >
                          {slackChannels.map((c) => (
                            <option key={c.id} value={c.channelId}>
                              {c.label}
                              {c.isDefault ? ' (default)' : ''}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <p className="ml-6 mt-1 text-[10px] text-amber-900/70">
                          Using the fallback channel — add channels at Settings → Slack channels.
                        </p>
                      )
                    ) : null}

                    <label className="mt-2 flex items-center gap-2 text-sm text-neutral-800">
                      <input
                        type="checkbox"
                        checked={createTask}
                        onChange={(e) => setCreateTask(e.target.checked)}
                      />
                      Create a task for this customer
                    </label>
                    {createTask ? (
                      <select
                        value={taskAssigneeId}
                        onChange={(e) => setTaskAssigneeId(e.target.value)}
                        aria-label="Task assignee"
                        className="ml-6 mt-1 w-[calc(100%-1.5rem)] rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
                      >
                        <option value="">Assign to…</option>
                        {assignableUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name ?? u.email}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>

                  <div className="mt-3 flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowSend(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={sending || !canConfirm}
                      onClick={confirmSend}
                    >
                      {sending ? 'Sending…' : 'Send'}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
