// Inline reply + lifecycle actions for the Comms Centre thread view.
// ADR 0020 Phase 4. Reuses the audited outbound (interaction.trengo.reply,
// .close, .reopen) — no new server code. Virtual Assistants see the
// composer disabled per server-side FORBIDDEN; we surface the same intent
// in the UI by hiding the send button on the error toast.
//
// WhatsApp replies additionally offer the workspace's APPROVED Trengo
// templates (HSM) with inline {{n}} fill-in + live preview — the same
// composer Trengo shows, and the only send WhatsApp accepts once the
// 24-hour customer-service window has closed. Sent via the existing
// interaction.trengo.startWhatsappTemplate (audited, /wa_sessions).

'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import {
  missingWaParams,
  parseWaTemplateSegments,
  renderWaTemplate,
} from '@/components/contact/wa-template'
import { trpc } from '@/lib/trpc/client'

interface WaTemplate {
  id: number
  title: string
  body: string
  params: string[]
}

interface Props {
  conversationId: string
  contactId: string
  ticketId: number
  status: 'open' | 'closed' | 'snoozed' | 'archived'
  /** Channel of the conversation — filters which quick replies apply. */
  channel: string | null
  /** Contact display name — used to substitute {{first_name}} / {{name}}
   *  in a quick reply at insert time. */
  contactName: string | null
  /** Seed for the reply — we tell the server which inbound to thread
   *  against. Null when there are no messages yet (rare; we still allow
   *  the send to create the first outbound). */
  latestInteractionId: string | null
  /** WhatsApp 24h customer-service window: true = open (free text allowed),
   *  false = closed (only approved templates deliver), null = not WhatsApp. */
  replyWindowOpen?: boolean | null
}

/** Substitute the supported placeholders with the contact's details. */
function applyPlaceholders(body: string, contactName: string | null): string {
  const name = contactName?.trim() ?? ''
  const firstName = name.split(/\s+/)[0] ?? ''
  return body
    .replace(/\{\{\s*first_name\s*\}\}/gi, firstName)
    .replace(/\{\{\s*name\s*\}\}/gi, name)
}

export function ConversationReply({
  conversationId,
  contactId,
  ticketId,
  status,
  channel,
  contactName,
  latestInteractionId,
  replyWindowOpen = null,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [body, setBody] = useState('')

  // WhatsApp: default to the template composer when the 24h window has
  // closed — free text would be rejected by WhatsApp, templates deliver.
  const isWhatsapp = channel === 'whatsapp'
  const [mode, setMode] = useState<'text' | 'template'>(
    isWhatsapp && replyWindowOpen === false ? 'template' : 'text',
  )
  const [waTemplate, setWaTemplate] = useState<WaTemplate | null>(null)
  const [waParams, setWaParams] = useState<Record<string, string>>({})

  const waTemplates = trpc.contact.callSummary.waTemplates.useQuery(undefined, {
    enabled: isWhatsapp && mode === 'template',
    staleTime: 60_000,
  })

  const quickReplies = trpc.quickReply.list.useQuery(
    channel ? { channel: channel as 'whatsapp' | 'sms' | 'email' | 'web_chat' } : undefined,
    { staleTime: 5 * 60_000, retry: false },
  )

  const [files, setFiles] = useState<File[]>([])
  const [reading, setReading] = useState(false)

  const insertQuickReply = (replyBody: string) => {
    const text = applyPlaceholders(replyBody, contactName)
    setBody((cur) => (cur.trim() ? `${cur}\n${text}` : text))
  }

  const send = trpc.interaction.trengo.reply.useMutation({
    onSuccess: () => {
      setBody('')
      setFiles([])
      toast.success('Reply sent')
      void utils.inbox.conversations.get.invalidate({ conversationId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not send reply'),
  })

  const sendTemplate = trpc.interaction.trengo.startWhatsappTemplate.useMutation({
    onSuccess: () => {
      setWaTemplate(null)
      setWaParams({})
      toast.success('Template sent')
      void utils.inbox.conversations.get.invalidate({ conversationId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not send the template'),
  })

  const waSegments = useMemo(
    () => (waTemplate ? parseWaTemplateSegments(waTemplate.body) : []),
    [waTemplate],
  )
  const waPreview = waTemplate ? renderWaTemplate(waTemplate.body, waParams) : ''
  const waMissing = waTemplate ? missingWaParams(waTemplate.params, waParams) : []

  const close = trpc.interaction.trengo.close.useMutation({
    onSuccess: () => {
      toast.success('Conversation closed in Trengo')
      void utils.inbox.conversations.get.invalidate({ conversationId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not close conversation'),
  })

  const reopen = trpc.interaction.trengo.reopen.useMutation({
    onSuccess: () => {
      toast.success('Conversation reopened in Trengo')
      void utils.inbox.conversations.get.invalidate({ conversationId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not reopen conversation'),
  })

  const canSend = !!latestInteractionId
  const sendDisabled =
    send.isPending ||
    reading ||
    !canSend ||
    (!body.trim() && files.length === 0)

  const MAX_BYTES = 8 * 1024 * 1024

  const onPickFiles = (picked: FileList | null) => {
    if (!picked) return
    const next = [...files]
    for (const f of Array.from(picked)) {
      if (f.size > MAX_BYTES) {
        toast.error(`${f.name} is over 8 MB`)
        continue
      }
      if (next.length >= 10) break
      next.push(f)
    }
    setFiles(next)
  }

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = reader.result as string
        // strip the "data:<mime>;base64," prefix
        resolve(result.slice(result.indexOf(',') + 1))
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })

  const handleSend = async () => {
    if (!latestInteractionId || sendDisabled) return
    let attachments:
      | Array<{ filename: string; contentType: string; dataBase64: string }>
      | undefined
    if (files.length > 0) {
      setReading(true)
      try {
        attachments = await Promise.all(
          files.map(async (f) => ({
            filename: f.name,
            contentType: f.type || 'application/octet-stream',
            dataBase64: await fileToBase64(f),
          })),
        )
      } catch {
        toast.error('Could not read the attached file(s)')
        setReading(false)
        return
      }
      setReading(false)
    }
    send.mutate({ interactionId: latestInteractionId, body, attachments })
  }

  const waData = waTemplates.data
  const templateSendDisabled =
    sendTemplate.isPending || !waTemplate || waMissing.length > 0

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
          Reply
          {isWhatsapp ? (
            <span className="inline-flex rounded-md border border-neutral-200 bg-neutral-100 p-0.5 normal-case tracking-normal">
              {(['text', 'template'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  aria-pressed={mode === m}
                  className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                    mode === m
                      ? 'bg-white text-neutral-900 shadow-sm'
                      : 'text-neutral-600 hover:text-neutral-900'
                  }`}
                >
                  {m === 'text' ? 'Free text' : 'Approved template'}
                </button>
              ))}
            </span>
          ) : null}
        </span>
        {mode === 'text' && (quickReplies.data?.length ?? 0) > 0 ? (
          <select
            defaultValue=""
            onChange={(e) => {
              const qr = quickReplies.data?.find((q) => q.id === e.target.value)
              if (qr) insertQuickReply(qr.body)
              e.currentTarget.value = ''
            }}
            className="max-w-[14rem] rounded border border-neutral-300 bg-white px-2 py-1 text-xs"
            aria-label="Insert a quick reply"
          >
            <option value="" disabled>
              Quick reply…
            </option>
            {quickReplies.data!.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {mode === 'text' ? (
        <>
          {isWhatsapp && replyWindowOpen === false ? (
            <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              The 24-hour WhatsApp window has closed — WhatsApp will reject free
              text. Switch to “Approved template” to message this customer.
            </p>
          ) : null}
          <label className="flex flex-col gap-1 text-sm">
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder={
                canSend
                  ? 'Write your reply here. Sends through Trengo on the same channel.'
                  : 'No inbound message to reply to yet.'
              }
              className="w-full rounded border border-neutral-300 bg-white p-2 font-mono text-sm focus:border-primary-500 focus:outline-none"
            />
          </label>

          {files.length > 0 ? (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <li
                  key={`${f.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-700"
                >
                  {f.name} · {Math.round(f.size / 1024)} KB
                  <button
                    type="button"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="text-neutral-400 hover:text-danger-600"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        /* ── WhatsApp approved-template composer — mirrors Trengo's own:
              pick the template, fill each {{n}} inline, watch the preview. ── */
        <div className="space-y-2">
          {waTemplates.isLoading ? (
            <p className="text-xs text-neutral-500">Loading templates from Trengo…</p>
          ) : !waData?.available ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              {waData?.reason ?? 'Could not load WhatsApp templates from Trengo.'}
            </p>
          ) : waData.templates.length === 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              No approved WhatsApp templates in your Trengo workspace yet — add one
              in Trengo first.
            </p>
          ) : !waTemplate ? (
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {waData.templates.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setWaTemplate(t)
                      setWaParams({})
                    }}
                    className="w-full rounded-md border border-neutral-200 bg-white px-3 py-2 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40"
                  >
                    <span className="block text-xs font-semibold text-neutral-900">
                      {t.title}
                    </span>
                    <span className="mt-0.5 block whitespace-pre-wrap text-xs leading-snug text-neutral-600">
                      {t.body}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-900">
                  {waTemplate.title}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setWaTemplate(null)
                    setWaParams({})
                  }}
                  className="text-xs text-primary-700 hover:underline"
                >
                  ← Choose a different template
                </button>
              </div>
              <div className="whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm leading-relaxed text-neutral-800">
                {waSegments.map((seg, i) =>
                  seg.kind === 'text' ? (
                    <span key={i}>{seg.text}</span>
                  ) : seg.first ? (
                    <input
                      key={i}
                      value={waParams[seg.key] ?? ''}
                      onChange={(e) =>
                        setWaParams((prev) => ({ ...prev, [seg.key]: e.target.value }))
                      }
                      placeholder={seg.key}
                      aria-label={`Template variable ${seg.key}`}
                      className="mx-0.5 inline-block w-32 rounded border border-primary-300 bg-white px-1.5 py-0.5 text-sm focus:border-primary-500 focus:outline-none"
                    />
                  ) : (
                    <span
                      key={i}
                      className="mx-0.5 rounded bg-primary-100 px-1 text-primary-800"
                    >
                      {(waParams[seg.key] ?? '').trim() || seg.key}
                    </span>
                  ),
                )}
              </div>
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                  Preview
                </p>
                <div className="max-w-md whitespace-pre-wrap rounded-lg rounded-tl-none border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-relaxed text-neutral-900">
                  {waPreview}
                </div>
                {waMissing.length > 0 ? (
                  <p className="mt-1 text-xs text-amber-700">
                    Fill {waMissing.join(', ')} to send — WhatsApp rejects templates
                    with empty variables.
                  </p>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mode === 'text' ? (
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sendDisabled}
            className="rounded bg-primary-600 px-3 py-1 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {send.isPending || reading ? 'Sending…' : 'Send'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (!waTemplate) return
              sendTemplate.mutate({
                contactId,
                templateId: waTemplate.id,
                templateTitle: waTemplate.title,
                params: waTemplate.params.map((key) => ({
                  key,
                  value: (waParams[key] ?? '').trim(),
                })),
                renderedBody: waPreview,
              })
            }}
            disabled={templateSendDisabled}
            className="rounded bg-primary-600 px-3 py-1 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {sendTemplate.isPending ? 'Sending…' : 'Send template'}
          </button>
        )}
        {mode === 'text' ? (
          <label className="cursor-pointer rounded border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50">
            Attach
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onPickFiles(e.target.files)
                e.currentTarget.value = ''
              }}
            />
          </label>
        ) : null}
        {status === 'closed' ? (
          <button
            type="button"
            onClick={() =>
              reopen.mutate({ contactId, ticketId })
            }
            disabled={reopen.isPending}
            className="rounded border border-primary-200 bg-primary-50 px-3 py-1 text-sm text-primary-800 hover:bg-primary-100 disabled:opacity-50"
          >
            {reopen.isPending ? 'Reopening…' : 'Reopen conversation'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => close.mutate({ contactId, ticketId })}
            disabled={close.isPending}
            className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            {close.isPending ? 'Closing…' : 'Close conversation'}
          </button>
        )}
        <span className="text-xs text-neutral-500">
          Send + state changes sync to Trengo.
        </span>
      </div>
    </div>
  )
}
