// A single message row in the channel feed or a thread (ADR 0022). Shows the
// author, body (markdown + chips), reactions, and a Slack-style hover action
// bar: quick-react, reply-in-thread, forward, pin, save, edit, delete. A
// message with replies shows a prominent "N replies" thread affordance, and a
// pinned message shows a "Pinned" label.

'use client'

import { useEffect, useRef, useState } from 'react'

import { Avatar } from '@/components/ui/avatar'
import {
  ForwardIcon,
  PencilIcon,
  PinIcon,
  ReplyIcon,
  SmilePlusIcon,
  StarIcon,
  Trash2Icon,
} from '@/components/ui/icon'
import { CHAT_REACTION_EMOJI } from '@studymind/core/chat'
import { formatRelativeTime } from '@/lib/format/relative-time'

import { Attachments } from './Attachments'
import { Composer } from './Composer'
import { MessageBody } from './MessageBody'
import { Reactions } from './Reactions'
import type { MessageView } from './types'

interface Props {
  message: MessageView
  viewerId: string
  canModerate: boolean
  userNames: Record<string, string>
  showThreadAffordance?: boolean
  onReact: (messageId: string, emoji: string) => void
  onOpenThread?: (rootId: string) => void
  onEdit: (id: string, body: string) => void
  onDelete: (id: string) => void
  onForward?: (messageId: string) => void
  onPin?: (messageId: string, pinned: boolean) => void
  onSave?: (messageId: string, saved: boolean) => void
}

export function MessageRow({
  message,
  viewerId,
  canModerate,
  userNames,
  showThreadAffordance = true,
  onReact,
  onOpenThread,
  onEdit,
  onDelete,
  onForward,
  onPin,
  onSave,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const barRef = useRef<HTMLDivElement | null>(null)
  const isAuthor = message.authorId === viewerId
  const deleted = message.deletedAt != null

  useEffect(() => {
    if (!emojiOpen && !moreOpen) return
    function onDown(e: MouseEvent) {
      if (!barRef.current?.contains(e.target as Node)) {
        setEmojiOpen(false)
        setMoreOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setEmojiOpen(false)
        setMoreOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [emojiOpen, moreOpen])

  if (deleted) {
    return (
      <div className="flex gap-3 px-4 py-1.5">
        <div className="w-9 shrink-0" />
        <p className="text-xs italic text-neutral-400">This message was deleted.</p>
      </div>
    )
  }

  // The quick-react row in Slack shows a few frequent emoji inline. We surface
  // the first four from the curated set, plus a "+" that opens the full picker.
  const QUICK = CHAT_REACTION_EMOJI.slice(0, 4)

  return (
    <div className="group relative flex gap-3 px-4 py-1.5 hover:bg-neutral-50/70">
      <div className="shrink-0 pt-0.5">
        <Avatar name={message.authorName} size={36} />
      </div>

      <div className="min-w-0 flex-1">
        {message.pinned ? (
          <span className="mb-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-amber-700">
            <PinIcon size={11} /> Pinned
          </span>
        ) : null}
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold text-neutral-900">{message.authorName}</span>
          <span className="text-[11px] text-neutral-400">
            {formatRelativeTime(message.createdAt)}
          </span>
          {message.editedAt ? (
            <span className="text-[11px] text-neutral-300">(edited)</span>
          ) : null}
        </div>

        {editing ? (
          <div className="mt-1">
            <Composer
              placeholder="Edit message…"
              autoFocus
              initialValue={message.body}
              onSend={(body) => {
                onEdit(message.id, body)
                setEditing(false)
              }}
            />
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="mt-1 text-xs text-neutral-500 hover:text-neutral-800"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="mt-0.5">
            {message.body ? (
              <MessageBody
                body={message.body}
                userNames={userNames}
                refs={message.refs}
                viewerId={viewerId}
              />
            ) : null}
            {message.attachments.length > 0 ? (
              <Attachments attachments={message.attachments} />
            ) : null}
          </div>
        )}

        {/* Reactions */}
        {!editing ? (
          <div className="mt-1">
            <Reactions
              reactions={message.reactions}
              compact
              onToggle={(emoji) => onReact(message.id, emoji)}
            />
          </div>
        ) : null}

        {/* Thread affordance — prominent, Slack-style */}
        {showThreadAffordance && message.replyCount > 0 && onOpenThread ? (
          <button
            type="button"
            onClick={() => onOpenThread(message.id)}
            className="mt-1.5 inline-flex items-center gap-2 rounded-md border border-transparent px-1.5 py-1 text-xs font-medium text-primary-700 hover:border-neutral-200 hover:bg-white"
          >
            <span className="flex -space-x-1.5">
              {message.replyAuthorNames.slice(0, 3).map((n, i) => (
                <Avatar key={i} name={n} size={18} className="ring-2 ring-white" />
              ))}
            </span>
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            {message.lastReplyAt ? (
              <span className="font-normal text-neutral-400">
                · last reply {formatRelativeTime(message.lastReplyAt)}
              </span>
            ) : null}
            <span className="font-normal text-primary-600">· View thread</span>
          </button>
        ) : null}
      </div>

      {/* Hover action bar (Slack-style) */}
      {!editing ? (
        <div
          ref={barRef}
          className="absolute -top-3 right-3 z-10 hidden items-center gap-0.5 rounded-lg border border-neutral-200 bg-white p-0.5 shadow-sm group-hover:flex"
        >
          {/* Inline quick-react emoji */}
          {QUICK.map((emoji) => (
            <button
              key={emoji}
              type="button"
              title={`React ${emoji}`}
              aria-label={`React ${emoji}`}
              onClick={() => onReact(message.id, emoji)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-base hover:bg-neutral-100"
            >
              {emoji}
            </button>
          ))}
          <div className="relative">
            <button
              type="button"
              title="More reactions"
              aria-label="More reactions"
              onClick={() => {
                setEmojiOpen((v) => !v)
                setMoreOpen(false)
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            >
              <SmilePlusIcon size={15} />
            </button>
            {emojiOpen ? (
              <div className="absolute right-0 top-8 z-20 flex flex-wrap gap-0.5 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg">
                {CHAT_REACTION_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onReact(message.id, emoji)
                      setEmojiOpen(false)
                    }}
                    className="rounded-md px-1.5 py-1 text-base hover:bg-neutral-100"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <span className="mx-0.5 h-4 w-px bg-neutral-200" aria-hidden />

          {showThreadAffordance && onOpenThread ? (
            <button
              type="button"
              title="Reply in thread"
              aria-label="Reply in thread"
              onClick={() => onOpenThread(message.id)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            >
              <ReplyIcon size={15} />
            </button>
          ) : null}
          {onForward ? (
            <button
              type="button"
              title="Forward"
              aria-label="Forward message"
              onClick={() => onForward(message.id)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            >
              <ForwardIcon size={15} />
            </button>
          ) : null}
          {onSave ? (
            <button
              type="button"
              title={message.saved ? 'Remove from saved' : 'Save for later'}
              aria-label={message.saved ? 'Remove from saved' : 'Save for later'}
              aria-pressed={message.saved}
              onClick={() => onSave(message.id, !message.saved)}
              className={
                message.saved
                  ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-amber-500 hover:bg-amber-50'
                  : 'inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800'
              }
            >
              <StarIcon size={15} fill={message.saved ? 'currentColor' : 'none'} />
            </button>
          ) : null}
          {onPin ? (
            <button
              type="button"
              title={message.pinned ? 'Unpin from channel' : 'Pin to channel'}
              aria-label={message.pinned ? 'Unpin from channel' : 'Pin to channel'}
              aria-pressed={message.pinned}
              onClick={() => onPin(message.id, !message.pinned)}
              className={
                message.pinned
                  ? 'inline-flex h-7 w-7 items-center justify-center rounded-md text-primary-600 hover:bg-primary-50'
                  : 'inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800'
              }
            >
              <PinIcon size={15} />
            </button>
          ) : null}
          {isAuthor ? (
            <button
              type="button"
              title="Edit"
              aria-label="Edit message"
              onClick={() => setEditing(true)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
            >
              <PencilIcon size={14} />
            </button>
          ) : null}
          {isAuthor || canModerate ? (
            <button
              type="button"
              title="Delete"
              aria-label="Delete message"
              onClick={() => {
                if (confirm('Delete this message?')) onDelete(message.id)
              }}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-red-50 hover:text-red-700"
            >
              <Trash2Icon size={14} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
