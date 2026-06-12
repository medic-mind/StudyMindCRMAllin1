// Start a brand-new Trengo conversation with this contact (ADR 0020 Phase 6j),
// reworked to mirror Trengo's own composer:
//
//   WhatsApp — lists the workspace's APPROVED Trengo templates exactly as
//   Trengo shows them (title + body), the agent picks one, fills each {{n}}
//   variable inline at its position in the message, watches the live preview
//   bubble update, and sends via /wa_sessions — the only send WhatsApp accepts
//   for a brand-new conversation (outside the 24h window). Free text is not
//   offered for new WhatsApp threads because WhatsApp itself rejects it.
//
//   SMS — lists the workspace's Trengo quick replies as pick-to-fill
//   templates; the inserted text stays editable, with the same live preview
//   bubble. Free text allowed (SMS has no template requirement).
//
//   Email — plain compose, unchanged.
//
// Pure template parsing/rendering lives in @/components/contact/wa-template
// (unit-tested). Sales Executive+ (the server gates both mutations).

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

type Channel = 'whatsapp' | 'sms' | 'email'

const CHANNELS: ReadonlyArray<{ value: Channel; label: string }> = [
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
]

interface WaTemplate {
  id: number
  title: string
  body: string
  params: string[]
}

export function StartTrengoConversation({ contactId }: { contactId: string }) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState<Channel>('whatsapp')
  const [body, setBody] = useState('')

  // WhatsApp template state.
  const [waTemplate, setWaTemplate] = useState<WaTemplate | null>(null)
  const [waParams, setWaParams] = useState<Record<string, string>>({})

  const waTemplatesQuery = trpc.contact.callSummary.waTemplates.useQuery(undefined, {
    enabled: open && channel === 'whatsapp',
    staleTime: 60_000,
  })
  const quickRepliesQuery = trpc.interaction.trengo.quickReplies.useQuery(undefined, {
    enabled: open && channel === 'sms',
    staleTime: 60_000,
  })
  // "Send from" — the workspace's sender lines for the picked channel type.
  const channelsQuery = trpc.interaction.trengo.channels.useQuery(undefined, {
    enabled: open && channel !== 'whatsapp',
    staleTime: 5 * 60_000,
    retry: false,
  })
  const [fromChannelId, setFromChannelId] = useState<number | null>(null)
  const senderOptions =
    channelsQuery.data?.available === true
      ? channelsQuery.data.channels.filter((c) => c.kind === channel)
      : []

  const start = trpc.interaction.trengo.startConversation.useMutation({
    onSuccess: () => onSent(),
    onError: (e) => toast.error(e.message ?? 'Could not start the conversation'),
  })
  const startTemplate = trpc.interaction.trengo.startWhatsappTemplate.useMutation({
    onSuccess: () => onSent(),
    onError: (e) => toast.error(e.message ?? 'Could not send the template'),
  })

  function onSent() {
    toast.success('Conversation started')
    resetCompose()
    setOpen(false)
    void utils.contact.channels.trengoConversations.invalidate({ contactId })
    router.refresh()
  }

  function resetCompose() {
    setBody('')
    setWaTemplate(null)
    setWaParams({})
  }

  function pickChannel(c: Channel) {
    setChannel(c)
    resetCompose()
  }

  const segments = useMemo(
    () => (waTemplate ? parseWaTemplateSegments(waTemplate.body) : []),
    [waTemplate],
  )
  const waPreview = waTemplate ? renderWaTemplate(waTemplate.body, waParams) : ''
  const waMissing = waTemplate ? missingWaParams(waTemplate.params, waParams) : []

  const sending = start.isPending || startTemplate.isPending

  function send() {
    if (channel === 'whatsapp') {
      if (!waTemplate) return
      startTemplate.mutate({
        contactId,
        templateId: waTemplate.id,
        templateTitle: waTemplate.title,
        params: waTemplate.params.map((key) => ({ key, value: (waParams[key] ?? '').trim() })),
        renderedBody: waPreview,
      })
      return
    }
    start.mutate({
      contactId,
      channel,
      body,
      ...(fromChannelId ? { trengoChannelId: fromChannelId } : {}),
    })
  }

  const canSend =
    channel === 'whatsapp'
      ? Boolean(waTemplate) && waMissing.length === 0
      : body.trim().length > 0

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-neutral-300 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
      >
        New conversation
      </button>
    )
  }

  const waData = waTemplatesQuery.data
  const qrData = quickRepliesQuery.data

  return (
    <div className="rounded-md border border-neutral-200 bg-white p-3 text-sm shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          New conversation
        </span>
        <div className="inline-flex rounded-md border border-neutral-200 bg-neutral-100 p-0.5">
          {CHANNELS.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => pickChannel(c.value)}
              aria-pressed={channel === c.value}
              className={`rounded px-2.5 py-0.5 text-xs font-medium transition-colors ${
                channel === c.value
                  ? 'bg-white text-neutral-900 shadow-sm'
                  : 'text-neutral-600 hover:text-neutral-900'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── WhatsApp: template picker + inline fill + live preview ── */}
      {channel === 'whatsapp' ? (
        <div className="mt-2 space-y-2">
          {waTemplatesQuery.isLoading ? (
            <p className="text-xs text-neutral-500">Loading templates from Trengo…</p>
          ) : !waData?.available ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              {waData?.reason ?? 'Could not load WhatsApp templates from Trengo.'}
            </p>
          ) : waData.templates.length === 0 ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
              No approved WhatsApp templates in your Trengo workspace yet. WhatsApp
              requires an approved template to open a new conversation — add one in
              Trengo first.
            </p>
          ) : !waTemplate ? (
            <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
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

              {/* The template body with the fill-in fields INLINE at the exact
                  placeholder positions — the same composer Trengo shows. */}
              <div className="whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm leading-relaxed text-neutral-800">
                {segments.map((seg, i) =>
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

              {/* Live preview — what the customer's WhatsApp will show. */}
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                  Preview
                </p>
                <div className="max-w-md rounded-lg rounded-tl-none border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed text-neutral-900">
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
      ) : null}

      {/* ── SMS: quick-reply templates + editable body + preview ── */}
      {channel === 'sms' ? (
        <div className="mt-2 space-y-2">
          {quickRepliesQuery.isLoading ? (
            <p className="text-xs text-neutral-500">Loading quick replies from Trengo…</p>
          ) : qrData?.available && qrData.replies.length > 0 ? (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                Trengo quick replies
              </p>
              <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto pr-1">
                {qrData.replies.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setBody(r.body)}
                    title={r.body}
                    className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
                  >
                    {r.title}
                  </button>
                ))}
              </div>
            </div>
          ) : qrData && !qrData.available ? (
            <p className="text-[11px] text-neutral-500">{qrData.reason}</p>
          ) : null}
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="SMS message… (pick a quick reply above, then edit)"
            className="w-full rounded border border-neutral-300 bg-white p-2 text-sm focus:border-primary-500 focus:outline-none"
          />
          {body.trim() ? (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                Preview
              </p>
              <div className="max-w-md rounded-lg rounded-tl-none border border-sky-200 bg-sky-50 px-3 py-2 text-sm whitespace-pre-wrap leading-relaxed text-neutral-900">
                {body}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ── Email: plain compose ── */}
      {channel === 'email' ? (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          placeholder="First message…"
          className="mt-2 w-full rounded border border-neutral-300 bg-white p-2 text-sm focus:border-primary-500 focus:outline-none"
        />
      ) : null}

      {channel !== 'whatsapp' && senderOptions.length > 1 ? (
        <label className="mt-2 flex items-center gap-1.5 text-xs text-neutral-700">
          <span className="font-medium">Send from</span>
          <select
            value={fromChannelId ?? ''}
            onChange={(e) =>
              setFromChannelId(e.target.value ? Number(e.target.value) : null)
            }
            className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs"
          >
            <option value="">Workspace default</option>
            {senderOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={send}
          disabled={sending || !canSend}
          className="rounded bg-primary-600 px-3 py-1 text-xs text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Send'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-xs text-neutral-500 hover:underline"
        >
          Cancel
        </button>
        <span className="text-xs text-neutral-400">
          {channel === 'whatsapp'
            ? 'New WhatsApp threads must use an approved template.'
            : channel === 'sms'
              ? 'Uses the contact’s phone number.'
              : 'Uses the contact’s email address.'}
        </span>
      </div>
    </div>
  )
}
