// Composer for the Comms Centre thread view. ADR 0020 Phase 4.
//
// Mirrors how Trengo itself behaves:
//  - WhatsApp inside the 24h window → free text sends straight away on the
//    open ticket (interaction.trengo.reply now targets the exact ticket).
//  - WhatsApp outside the window → the approved-template composer (Trengo
//    wa_templates, inline {{n}} fill, live preview) — the only send WhatsApp
//    accepts there. The agent can still flip modes by hand.
//  - SMS tab (when the contact has a phone) sends a normal SMS — clearly
//    labelled as its own conversation, not a WhatsApp message.
//
// All sends reuse the existing audited outbound procedures; Virtual
// Assistants get the server-side FORBIDDEN. CLAUDE.md §11, §20.

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

type SendChannel = 'whatsapp' | 'sms' | 'email' | 'web_chat'

const CHANNEL_META: Record<SendChannel, { label: string; chip: string }> = {
  whatsapp: {
    label: 'WhatsApp',
    chip: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  },
  sms: { label: 'SMS', chip: 'border-sky-200 bg-sky-50 text-sky-800' },
  email: { label: 'Email', chip: 'border-neutral-200 bg-neutral-100 text-neutral-700' },
  web_chat: {
    label: 'Web chat',
    chip: 'border-violet-200 bg-violet-50 text-violet-800',
  },
}

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
  /** Channel of the conversation — drives the default send tab. */
  channel: string | null
  /** Contact display name — used to substitute {{first_name}} / {{name}}
   *  in a quick reply at insert time. */
  contactName: string | null
  /** Contact's phone — enables the SMS tab on a WhatsApp thread. */
  contactPhone?: string | null
  /** Seed for the reply — we tell the server which inbound to thread
   *  against. Null when there are no messages yet (rare; we still allow
   *  the send to create the first outbound). */
  latestInteractionId: string | null
  /** WhatsApp 24h customer-service window: true = open (free text delivers),
   *  false = closed (only approved templates deliver), null = not WhatsApp /
   *  unknown. */
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
  contactPhone = null,
  latestInteractionId,
  replyWindowOpen = null,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()

  const threadChannel: SendChannel =
    channel === 'whatsapp' || channel === 'sms' || channel === 'email' || channel === 'web_chat'
      ? channel
      : 'whatsapp'
  // Tabs: the thread's own channel first; SMS offered alongside WhatsApp
  // when we hold a phone number (a separate conversation, clearly marked).
  const sendOptions: SendChannel[] =
    threadChannel === 'whatsapp' && contactPhone ? ['whatsapp', 'sms'] : [threadChannel]
  const [sendVia, setSendVia] = useState<SendChannel>(threadChannel)

  const [body, setBody] = useState('')

  // WhatsApp: free text while the window is open (exactly like Trengo);
  // the approved-template composer once it has closed.
  const isWhatsapp = sendVia === 'whatsapp' && threadChannel === 'whatsapp'
  const windowClosed = isWhatsapp && replyWindowOpen === false
  const [modeOverride, setModeOverride] = useState<'text' | 'template' | null>(null)
  const mode: 'text' | 'template' =
    modeOverride ?? (windowClosed ? 'template' : 'text')
  const [waTemplate, setWaTemplate] = useState<WaTemplate | null>(null)
  const [waParams, setWaParams] = useState<Record<string, string>>({})

  const waTemplates = trpc.contact.callSummary.waTemplates.useQuery(undefined, {
    enabled: isWhatsapp && mode === 'template',
    staleTime: 60_000,
  })

  const quickReplies = trpc.quickReply.list.useQuery(
    { channel: sendVia },
    { staleTime: 5 * 60_000, retry: false },
  )

  const [files, setFiles] = useState<File[]>([])
  const [reading, setReading] = useState(false)

  const insertQuickReply = (replyBody: string) => {
    const text = applyPlaceholders(replyBody, contactName)
    setBody((cur) => (cur.trim() ? `${cur}\n${text}` : text))
  }

  const invalidate = () => {
    void utils.inbox.conversations.get.invalidate({ conversationId })
    void utils.inbox.conversations.list.invalidate()
  }

  const send = trpc.interaction.trengo.reply.useMutation({
    onSuccess: () => {
      setBody('')
      setFiles([])
      toast.success('Reply sent')
      invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not send reply'),
  })

  const sendSms = trpc.interaction.trengo.startConversation.useMutation({
    onSuccess: () => {
      setBody('')
      toast.success('SMS sent')
      invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not send the SMS'),
  })

  const sendTemplate = trpc.interaction.trengo.startWhatsappTemplate.useMutation({
    onSuccess: () => {
      setWaTemplate(null)
      setWaParams({})
      toast.success('Template sent')
      invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not send the template'),
  })

  const close = trpc.interaction.trengo.close.useMutation({
    onSuccess: () => {
      toast.success('Conversation closed in Trengo')
      invalidate()
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not close conversation'),
  })

  const reopen = trpc.interaction.trengo.reopen.useMutation({
    onSuccess: () => {
      toast.success('Conversation reopened in Trengo')
      invalidate()
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not reopen conversation'),
  })

  const waSegments = useMemo(
    () => (waTemplate ? parseWaTemplateSegments(waTemplate.body) : []),
    [waTemplate],
  )
  const waPreview = waTemplate ? renderWaTemplate(waTemplate.body, waParams) : ''
  const waMissing = waTemplate ? missingWaParams(waTemplate.params, waParams) : []

  const sendingSeparateSms = sendVia === 'sms' && threadChannel !== 'sms'
  const isThreadReply = !sendingSeparateSms && mode === 'text'
  const sending = send.isPending || sendSms.isPending || sendTemplate.isPending || reading

  const sendDisabled = sendingSeparateSms
    ? sending || !body.trim()
    : mode === 'template'
      ? sending || !waTemplate || waMissing.length > 0
      : sending || !latestInteractionId || (!body.trim() && files.length === 0)

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
    if (sendDisabled) return
    if (sendingSeparateSms) {
      sendSms.mutate({ contactId, channel: 'sms', body })
      return
    }
    if (mode === 'template') {
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
      return
    }
    if (!latestInteractionId) return
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
    send.mutate({
      interactionId: latestInteractionId,
      body,
      attachments,
      ticketId,
      ...(threadChannel ? { channel: threadChannel } : {}),
    })
  }

  return (
    <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
      {/* Header: where this goes, in plain sight. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-100 bg-neutral-50/60 px-3 py-2">
        <span className="text-xs font-medium text-neutral-500">Send as</span>
        {sendOptions.map((opt) => {
          const active = sendVia === opt
          return (
            <button
              key={opt}
              type="button"
              onClick={() => setSendVia(opt)}
              aria-pressed={active}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                active
                  ? CHANNEL_META[opt].chip
                  : 'border-neutral-200 bg-white text-neutral-500 hover:text-neutral-800'
              }`}
            >
              {CHANNEL_META[opt].label}
            </button>
          )
        })}
        {isWhatsapp && replyWindowOpen !== null ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
              replyWindowOpen
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-red-50 text-red-700'
            }`}
          >
            {replyWindowOpen ? '24h window open — free text OK' : '24h window closed — template needed'}
          </span>
        ) : null}
        {isWhatsapp ? (
          <button
            type="button"
            onClick={() => setModeOverride(mode === 'text' ? 'template' : 'text')}
            className="ml-auto text-xs text-primary-700 hover:underline"
          >
            {mode === 'text' ? 'Use an approved template' : 'Write free text instead'}
          </button>
        ) : null}
      </div>

      <div className="p-3">
        {sendingSeparateSms ? (
          <p className="mb-2 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900">
            Sends a text message to{' '}
            <span className="font-mono">{contactPhone ?? 'this contact'}</span> — it
            starts a separate SMS conversation in Trengo, not a WhatsApp message.
          </p>
        ) : null}
        {!sendingSeparateSms && windowClosed && mode === 'text' ? (
          <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
            WhatsApp rejects free text once the 24-hour window has closed — use an
            approved template to reach this customer.
          </p>
        ) : null}

        {!sendingSeparateSms && mode === 'template' ? (
          <WaTemplatePicker
            loading={waTemplates.isLoading}
            data={waTemplates.data ?? null}
            template={waTemplate}
            segments={waSegments}
            params={waParams}
            preview={waPreview}
            missing={waMissing}
            onPick={(t) => {
              setWaTemplate(t)
              setWaParams({})
            }}
            onClear={() => {
              setWaTemplate(null)
              setWaParams({})
            }}
            onParam={(key, value) => setWaParams((prev) => ({ ...prev, [key]: value }))}
          />
        ) : (
          <>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder={
                sendingSeparateSms
                  ? 'Write the SMS…'
                  : isThreadReply && !latestInteractionId
                    ? 'No message to reply to yet.'
                    : `Write your ${CHANNEL_META[sendVia].label} reply… sends on this conversation through Trengo.`
              }
              className="w-full rounded-md border border-neutral-300 bg-white p-2 text-sm focus:border-primary-500 focus:outline-none"
            />
            {(quickReplies.data?.length ?? 0) > 0 ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                  Quick replies
                </span>
                {quickReplies.data!.slice(0, 6).map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => insertQuickReply(q.body)}
                    title={q.body}
                    className="rounded-full border border-neutral-200 bg-white px-2 py-0.5 text-xs text-neutral-600 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
                  >
                    {q.title}
                  </button>
                ))}
              </div>
            ) : null}
            {isThreadReply && files.length > 0 ? (
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
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sendDisabled}
            className="rounded bg-primary-600 px-3 py-1 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
          >
            {sending
              ? 'Sending…'
              : mode === 'template' && !sendingSeparateSms
                ? 'Send template'
                : sendingSeparateSms
                  ? 'Send SMS'
                  : 'Send'}
          </button>
          {isThreadReply ? (
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
              onClick={() => reopen.mutate({ contactId, ticketId })}
              disabled={reopen.isPending}
              className="rounded border border-primary-200 bg-primary-50 px-3 py-1 text-sm text-primary-800 hover:bg-primary-100 disabled:opacity-50"
            >
              {reopen.isPending ? 'Reopening…' : 'Reopen'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => close.mutate({ contactId, ticketId })}
              disabled={close.isPending}
              className="rounded border border-neutral-300 bg-white px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              {close.isPending ? 'Closing…' : 'Close'}
            </button>
          )}
          <span className="ml-auto text-xs text-neutral-400">Syncs to Trengo</span>
        </div>
      </div>
    </div>
  )
}

// ── WhatsApp approved-template picker — the same composer Trengo shows:
//    pick the template, fill each {{n}} inline, watch the live preview. ──

interface WaTemplatesData {
  available: boolean
  reason?: string | null
  templates: WaTemplate[]
}

function WaTemplatePicker({
  loading,
  data,
  template,
  segments,
  params,
  preview,
  missing,
  onPick,
  onClear,
  onParam,
}: {
  loading: boolean
  data: WaTemplatesData | null
  template: WaTemplate | null
  segments: ReturnType<typeof parseWaTemplateSegments>
  params: Record<string, string>
  preview: string
  missing: string[]
  onPick: (t: WaTemplate) => void
  onClear: () => void
  onParam: (key: string, value: string) => void
}) {
  if (loading) {
    return <p className="text-xs text-neutral-500">Loading templates from Trengo…</p>
  }
  if (!data?.available) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        {data?.reason ?? 'Could not load WhatsApp templates from Trengo.'}
      </p>
    )
  }
  if (data.templates.length === 0) {
    return (
      <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
        No approved WhatsApp templates in your Trengo workspace yet — add one in
        Trengo first.
      </p>
    )
  }
  if (!template) {
    return (
      <div>
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
          Pick an approved template
        </p>
        <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
          {data.templates.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-left transition-colors hover:border-primary-300 hover:bg-primary-50/40"
              >
                <span className="block text-xs font-semibold text-neutral-900">
                  {t.title}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-neutral-500">
                  {t.body}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-neutral-900">{template.title}</span>
        <button
          type="button"
          onClick={onClear}
          className="text-xs text-primary-700 hover:underline"
        >
          ← Different template
        </button>
      </div>
      <div className="whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm leading-relaxed text-neutral-800">
        {segments.map((seg, i) =>
          seg.kind === 'text' ? (
            <span key={i}>{seg.text}</span>
          ) : seg.first ? (
            <input
              key={i}
              value={params[seg.key] ?? ''}
              onChange={(e) => onParam(seg.key, e.target.value)}
              placeholder={seg.key}
              aria-label={`Template variable ${seg.key}`}
              className="mx-0.5 inline-block w-32 rounded border border-primary-300 bg-white px-1.5 py-0.5 text-sm focus:border-primary-500 focus:outline-none"
            />
          ) : (
            <span key={i} className="mx-0.5 rounded bg-primary-100 px-1 text-primary-800">
              {(params[seg.key] ?? '').trim() || seg.key}
            </span>
          ),
        )}
      </div>
      <div>
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
          The customer will see
        </p>
        <div className="max-w-md whitespace-pre-wrap rounded-lg rounded-tl-none border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm leading-relaxed text-neutral-900">
          {preview}
        </div>
        {missing.length > 0 ? (
          <p className="mt-1 text-xs text-amber-700">
            Fill {missing.join(', ')} to send — WhatsApp rejects templates with empty
            variables.
          </p>
        ) : null}
      </div>
    </div>
  )
}
