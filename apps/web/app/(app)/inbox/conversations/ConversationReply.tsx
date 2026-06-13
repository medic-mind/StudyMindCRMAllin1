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
import { EmojiPicker } from '@/components/ui/emoji-picker'
import { trpc } from '@/lib/trpc/client'

type SendChannel = 'whatsapp' | 'sms' | 'email' | 'web_chat'

const CHANNEL_META: Record<SendChannel, { label: string }> = {
  whatsapp: { label: 'WhatsApp' },
  sms: { label: 'SMS' },
  email: { label: 'Email' },
  web_chat: { label: 'Web chat' },
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

  // Workspace sender lines — when the workspace runs several channels of the
  // picked type (Study Mind Support, MM ANZ, …), the agent chooses which one
  // the message goes from, exactly like Trengo's own composer.
  const sendingSeparateSmsPre = sendVia === 'sms' && threadChannel !== 'sms'
  const workspaceChannels = trpc.interaction.trengo.channels.useQuery(undefined, {
    enabled: sendingSeparateSmsPre,
    staleTime: 5 * 60_000,
    retry: false,
  })
  const [fromChannelId, setFromChannelId] = useState<number | null>(null)
  const smsChannels =
    workspaceChannels.data?.available === true
      ? workspaceChannels.data.channels.filter((c) => c.kind === 'sms')
      : []

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

  // Trengo's "Send and close": send the reply, then (when asked) close the
  // ticket in one step. We use mutateAsync so the close only fires after the
  // send actually succeeds; a send error surfaces its own toast and we stop.
  const handleSend = async (thenClose = false) => {
    if (sendDisabled) return
    try {
      if (sendingSeparateSms) {
        await sendSms.mutateAsync({
          contactId,
          channel: 'sms',
          body,
          ...(fromChannelId ? { trengoChannelId: fromChannelId } : {}),
        })
      } else if (mode === 'template') {
        if (!waTemplate) return
        await sendTemplate.mutateAsync({
          contactId,
          templateId: waTemplate.id,
          templateTitle: waTemplate.title,
          params: waTemplate.params.map((key) => ({
            key,
            value: (waParams[key] ?? '').trim(),
          })),
          renderedBody: waPreview,
        })
      } else {
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
        await send.mutateAsync({
          interactionId: latestInteractionId,
          body,
          attachments,
          ticketId,
          ...(threadChannel ? { channel: threadChannel } : {}),
        })
      }
    } catch {
      // The mutation's onError already toasted; don't close on a failed send.
      return
    }
    if (thenClose && status !== 'closed') {
      try {
        await close.mutateAsync({ contactId, ticketId })
      } catch {
        // onError toast already shown; the reply still went out.
      }
    }
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
                  ? 'border-primary-200 bg-primary-50 text-primary-800'
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
                ? 'bg-success-50 text-success-700'
                : 'bg-warning-50 text-warning-700'
            }`}
          >
            {replyWindowOpen ? '24h open' : 'Template only'}
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
          <div className="mb-2 space-y-1.5 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900">
            <p>
              Sends a text message to{' '}
              <span className="font-mono">{contactPhone ?? 'this contact'}</span> — it
              starts a separate SMS conversation in Trengo, not a WhatsApp message.
            </p>
            {smsChannels.length > 1 ? (
              <label className="flex items-center gap-1.5">
                <span className="font-medium">Send from</span>
                <select
                  value={fromChannelId ?? ''}
                  onChange={(e) =>
                    setFromChannelId(e.target.value ? Number(e.target.value) : null)
                  }
                  className="rounded border border-sky-300 bg-white px-1.5 py-0.5 text-xs text-neutral-900"
                >
                  <option value="">Workspace default</option>
                  {smsChannels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
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
            onClick={() => void handleSend(false)}
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
          {/* Trengo's "Send and close" — fire the reply then close the ticket
              in one step. Hidden once the conversation is already closed
              (the thread header owns Reopen). */}
          {status !== 'closed' ? (
            <button
              type="button"
              onClick={() => void handleSend(true)}
              disabled={sendDisabled || close.isPending}
              className="rounded border border-emerald-300 bg-emerald-50 px-3 py-1 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
            >
              {close.isPending ? 'Closing…' : 'Send & close'}
            </button>
          ) : null}
          {mode === 'text' ? (
            <EmojiPicker onPick={(e) => setBody((cur) => cur + e)} />
          ) : null}
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
  const [search, setSearch] = useState('')
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
    const q = search.trim().toLowerCase()
    const filtered = q
      ? data.templates.filter(
          (t) =>
            t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q),
        )
      : data.templates
    return (
      <div>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search templates…"
          aria-label="Search templates"
          className="mb-1.5 w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm focus:border-primary-500 focus:outline-none"
        />
        <ul className="max-h-52 space-y-1 overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <li className="px-1 py-2 text-xs text-neutral-400">
              No templates match “{search}”.
            </li>
          ) : (
            filtered.map((t) => (
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
            ))
          )}
        </ul>
      </div>
    )
  }
  // Trengo-style split: the fill-in form on the left, a WhatsApp phone-frame
  // preview on the right that updates as variables are typed.
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
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            Body — replace each variable with plain text
          </p>
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
                <span
                  key={i}
                  className="mx-0.5 rounded bg-primary-100 px-1 text-primary-800"
                >
                  {(params[seg.key] ?? '').trim() || seg.key}
                </span>
              ),
            )}
          </div>
          {missing.length > 0 ? (
            <p className="mt-1 text-xs text-amber-700">
              Fill {missing.join(', ')} to send — WhatsApp rejects templates with
              empty variables.
            </p>
          ) : null}
        </div>
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
            The customer will see
          </p>
          <div className="mx-auto w-full max-w-[260px] rounded-[1.75rem] border-4 border-neutral-200 bg-amber-50/60 p-3 shadow-inner">
            <div className="whitespace-pre-wrap rounded-lg rounded-tl-none border border-emerald-200 bg-white px-3 py-2 text-[13px] leading-relaxed text-neutral-900 shadow-sm">
              {preview}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
