'use client'

// Two-way action bar for an email thread (ADR 0021 Phase 5). Each button
// mutates the live Gmail mailbox via tRPC and reflects on the Conversation
// head. Reversible — trash goes to Gmail Trash (recoverable). Sales Executive
// and above; the server enforces too. CLAUDE.md §14, §20, §26.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

interface Props {
  conversationId: string
  unread: boolean
  archived: boolean
}

export function MailThreadActions({ conversationId, unread, archived }: Props) {
  const router = useRouter()
  const [confirmTrash, setConfirmTrash] = useState(false)
  const setRead = trpc.mail.thread.setRead.useMutation()
  const setArchived = trpc.mail.thread.setArchived.useMutation()
  const setStarred = trpc.mail.thread.setStarred.useMutation()
  const setTrashed = trpc.mail.thread.setTrashed.useMutation()

  const busy =
    setRead.isPending ||
    setArchived.isPending ||
    setStarred.isPending ||
    setTrashed.isPending

  async function run(p: Promise<unknown>, ok: string) {
    try {
      await p
      toast.success(ok)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not complete that')
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white p-2 shadow-sm">
      <span className="px-1 text-xs font-medium text-neutral-500">
        Syncs to Gmail
      </span>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          run(
            setRead.mutateAsync({ conversationId, read: unread }),
            unread ? 'Marked read' : 'Marked unread',
          )
        }
      >
        {unread ? 'Mark read' : 'Mark unread'}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          run(
            setArchived.mutateAsync({ conversationId, archived: !archived }),
            archived ? 'Moved to inbox' : 'Archived',
          )
        }
      >
        {archived ? 'Move to inbox' : 'Archive'}
      </Button>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={busy}
        onClick={() =>
          run(setStarred.mutateAsync({ conversationId, starred: true }), 'Starred')
        }
      >
        Star
      </Button>
      {confirmTrash ? (
        <span className="flex items-center gap-1.5">
          <span className="text-xs text-neutral-600">Move to Trash?</span>
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              run(
                setTrashed.mutateAsync({ conversationId, trashed: true }),
                'Moved to Trash',
              )
            }
          >
            Confirm
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() => setConfirmTrash(false)}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={busy}
          onClick={() => setConfirmTrash(true)}
        >
          Trash
        </Button>
      )}
    </div>
  )
}
