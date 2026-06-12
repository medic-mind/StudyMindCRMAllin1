// Side drawer for a channel's Pins or the viewer's Saved items (ADR 0022 —
// pins & saves). Mirrors the ThreadPanel layout. Each row shows the message
// (read-only body + attachments) with a jump-to affordance and a quick unpin /
// unsave. Saved spans all channels, so it shows each item's channel name.

'use client'

import { PinIcon, StarIcon, XIcon } from '@/components/ui/icon'
import { Avatar } from '@/components/ui/avatar'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

import { Attachments } from './Attachments'
import { MessageBody } from './MessageBody'

interface Props {
  kind: 'pins' | 'saved'
  channelId: string
  viewerId: string
  onClose: () => void
  /** Jump to a message (or open its thread when it's a reply). */
  onJump: (messageId: string, parentId: string | null) => void
  onUnpin: (messageId: string) => void
  onUnsave: (messageId: string) => void
}

export function PinsSavedPanel({
  kind,
  channelId,
  viewerId,
  onClose,
  onJump,
  onUnpin,
  onUnsave,
}: Props) {
  const pinsQuery = trpc.chat.listPins.useQuery(
    { channelId },
    { enabled: kind === 'pins', refetchInterval: 60_000 },
  )
  const savesQuery = trpc.chat.listSaves.useQuery(
    {},
    { enabled: kind === 'saved', refetchInterval: 60_000 },
  )

  const isPins = kind === 'pins'
  const loading = isPins ? pinsQuery.isLoading : savesQuery.isLoading
  const items = isPins ? (pinsQuery.data?.items ?? []) : (savesQuery.data?.items ?? [])

  return (
    <aside
      className="flex w-full max-w-md shrink-0 flex-col border-l border-neutral-200 bg-white"
      aria-label={isPins ? 'Pinned messages' : 'Saved items'}
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
          {isPins ? <PinIcon size={15} /> : <StarIcon size={15} />}
          {isPins ? 'Pinned' : 'Saved'}
        </h2>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
        >
          <XIcon size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {loading ? (
          <p className="px-4 py-6 text-sm text-neutral-500">Loading…</p>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-100 text-neutral-400">
              {isPins ? <PinIcon size={20} /> : <StarIcon size={20} />}
            </div>
            <p className="mt-2 text-sm font-medium text-neutral-700">
              {isPins ? 'No pinned messages' : 'No saved messages'}
            </p>
            <p className="mt-0.5 text-sm text-neutral-500">
              {isPins
                ? 'Pin a message to keep it handy for the whole channel.'
                : 'Save a message to find it again here — only you can see your saves.'}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {items.map((item) => {
              const m = item.message
              const meta = isPins
                ? `Pinned by ${'pinnedByName' in item ? item.pinnedByName : ''}`
                : 'channelTitle' in item
                  ? item.channelTitle
                  : ''
              return (
                <li key={m.id} className="group px-4 py-3 hover:bg-neutral-50/70">
                  <div className="flex items-start gap-2.5">
                    <Avatar name={m.authorName} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm font-semibold text-neutral-900">
                          {m.authorName}
                        </span>
                        <span className="text-[11px] text-neutral-400">
                          {formatRelativeTime(m.createdAt)}
                        </span>
                      </div>
                      {m.body ? (
                        <div className="mt-0.5 line-clamp-4">
                          <MessageBody
                            body={m.body}
                            userNames={{ [m.authorId]: m.authorName }}
                            refs={m.refs}
                            viewerId={viewerId}
                          />
                        </div>
                      ) : null}
                      {m.attachments.length > 0 ? (
                        <Attachments attachments={m.attachments} />
                      ) : null}
                      <div className="mt-1.5 flex items-center gap-3 text-[11px]">
                        <span className="text-neutral-400">{meta}</span>
                        <button
                          type="button"
                          onClick={() => onJump(m.id, m.parentId)}
                          className="font-medium text-primary-700 hover:underline"
                        >
                          Jump to message
                        </button>
                        <button
                          type="button"
                          onClick={() => (isPins ? onUnpin(m.id) : onUnsave(m.id))}
                          className="text-neutral-400 hover:text-red-700"
                        >
                          {isPins ? 'Unpin' : 'Unsave'}
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
