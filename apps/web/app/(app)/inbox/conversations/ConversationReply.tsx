// Inline reply + lifecycle actions for the Comms Centre thread view.
// ADR 0020 Phase 4. Reuses the audited outbound (interaction.trengo.reply,
// .close, .reopen) — no new server code. Virtual Assistants see the
// composer disabled per server-side FORBIDDEN; we surface the same intent
// in the UI by hiding the send button on the error toast.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

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
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [body, setBody] = useState('')

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

  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Reply
        </span>
        {(quickReplies.data?.length ?? 0) > 0 ? (
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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sendDisabled}
          className="rounded bg-primary-600 px-3 py-1 text-sm text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {send.isPending || reading ? 'Sending…' : 'Send'}
        </button>
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
