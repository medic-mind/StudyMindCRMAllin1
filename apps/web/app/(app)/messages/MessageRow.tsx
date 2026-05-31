// A single message row in the channel feed or a thread (ADR 0022). Shows the
// author, body (with chips), reactions, and on hover: react / reply / edit /
// delete. Author + Manager+ can delete; author can edit.

'use client'

import { useState } from 'react'

import { Avatar } from '@/components/ui/avatar'
import {
  PencilIcon,
  ReplyIcon,
  Trash2Icon,
} from '@/components/ui/icon'
import { formatRelativeTime } from '@/lib/format/relative-time'

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
}: Props) {
  const [editing, setEditing] = useState(false)
  const isAuthor = message.authorId === viewerId
  const deleted = message.deletedAt != null

  if (deleted) {
    return (
      <div className="flex gap-3 px-4 py-1.5">
        <div className="w-9 shrink-0" />
        <p className="text-xs italic text-neutral-400">This message was deleted.</p>
      </div>
    )
  }

  return (
    <div className="group relative flex gap-3 px-4 py-1.5 hover:bg-neutral-50/70">
      <div className="shrink-0 pt-0.5">
        <Avatar name={message.authorName} size={36} />
      </div>

      <div className="min-w-0 flex-1">
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
            <MessageBody
              body={message.body}
              userNames={userNames}
              refs={message.refs}
              viewerId={viewerId}
            />
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

        {/* Thread preview */}
        {showThreadAffordance && message.replyCount > 0 && onOpenThread ? (
          <button
            type="button"
            onClick={() => onOpenThread(message.id)}
            className="mt-1 inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-xs font-medium text-primary-700 hover:bg-primary-50"
          >
            <span className="flex -space-x-1.5">
              {message.replyAuthorNames.slice(0, 3).map((n, i) => (
                <Avatar key={i} name={n} size={18} className="ring-2 ring-white" />
              ))}
            </span>
            {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
            {message.lastReplyAt ? (
              <span className="font-normal text-neutral-400">
                · last {formatRelativeTime(message.lastReplyAt)}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>

      {/* Hover toolbar */}
      {!editing ? (
        <div className="absolute -top-3 right-3 hidden items-center gap-0.5 rounded-lg border border-neutral-200 bg-white p-0.5 shadow-sm group-hover:flex">
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
