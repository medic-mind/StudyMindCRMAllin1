// Card detail modal (slice A). A dialog opened by clicking a card on the
// board. Shows the backing contact, subject, labels, current stage, a move
// control + quick-action ticks, an inline-editable description, and the shared
// comment thread. Everything it writes (comment, description, move) is an
// Interaction so it surfaces on the contact timeline. CLAUDE.md §26, §20.
//
// We use the project's lightweight dialog pattern (a fixed overlay + focus
// management) rather than pulling in a new dependency. Esc closes; focus
// returns to the trigger via the parent.

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { CommentThread } from '@/components/thread/CommentThread'
import type { ThreadComment } from '@/components/thread/comment-types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { trpc } from '@/lib/trpc/client'

import { resolveStageColor } from '../../pipeline/stage-color'
import { CallSummarySection } from './CallSummarySection'
import { CardSidebar } from './CardSidebar'
import { CardSubtasks } from './CardSubtasks'
import { MoveCardMenu } from './MoveCardMenu'
import { QuickActionButtons } from './QuickActionButtons'

interface StageOption {
  id: string
  name: string
}
interface CrossBoardGroup {
  boardId: string
  boardName: string
  stages: ReadonlyArray<StageOption>
}
interface QuickAction {
  id: string
  label: string
  color: string | null
  targetStageId: string
  targetStageName: string
  targetBoardName: string | null
}

interface Props {
  cardId: string
  open: boolean
  onClose: () => void
  stages: ReadonlyArray<StageOption>
  crossBoardStages?: ReadonlyArray<CrossBoardGroup>
  quickActions: ReadonlyArray<QuickAction>
  canWrite: boolean
  canComment: boolean
  canDeleteCard: boolean
  currentUserName: string
}

export function CardModal({
  cardId,
  open,
  onClose,
  stages,
  crossBoardStages = [],
  quickActions,
  canWrite,
  canComment,
  canDeleteCard,
  currentUserName,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const confirm = useConfirm()
  const [editingDesc, setEditingDesc] = useState(false)
  const [descDraft, setDescDraft] = useState('')
  const closeRef = useRef<HTMLButtonElement>(null)

  const cardQuery = trpc.card.get.useQuery({ id: cardId }, { enabled: open })
  const commentsQuery = trpc.card.comments.list.useQuery({ cardId }, { enabled: open })

  const addComment = trpc.card.comments.add.useMutation()
  const deleteCardMutation = trpc.card.delete.useMutation({
    onSuccess: async () => {
      toast.success('Card permanently deleted')
      await utils.card.list.invalidate()
      onClose()
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not delete card'),
  })
  async function onDelete() {
    const name = cardQuery.data?.contactName ?? 'this card'
    const ok = await confirm({
      title: `Permanently delete the card for ${name}?`,
      body: "This cannot be undone. The card, its labels, and its sub-tasks will be removed. The backing contact and the card's history on the contact timeline are preserved.",
      confirmLabel: 'Delete card',
      tone: 'danger',
    })
    if (!ok) return
    deleteCardMutation.mutate({ id: cardId })
  }
  const setDescription = trpc.card.setDescription.useMutation({
    onSuccess: () => {
      toast.success('Description saved')
      setEditingDesc(false)
      void utils.card.get.invalidate({ id: cardId })
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not save description'),
  })

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    closeRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const card = cardQuery.data
  const comments: ThreadComment[] = (commentsQuery.data ?? []).map((c) => ({
    id: c.id,
    body: c.body,
    authorId: c.authorId,
    authorName: c.authorName,
    occurredAt: c.occurredAt,
  }))

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-neutral-900/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Card detail"
        className="grid w-full max-w-4xl overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl lg:grid-cols-[minmax(0,1fr)_18rem]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="col-span-full flex items-start justify-between gap-3 border-b border-neutral-100 px-5 py-3">
          <div className="min-w-0">
            {card ? (
              <>
                <Link
                  href={`/contacts/${card.contactId}`}
                  className="text-base font-semibold text-neutral-900 hover:text-primary-700 hover:underline"
                >
                  {card.contactName}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  {card.subject ? <Badge tone="info">{card.subject.name}</Badge> : null}
                  {card.labels.map((l) => (
                    <span
                      key={l.id}
                      className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                      style={{ backgroundColor: resolveStageColor(l.color) }}
                    >
                      {l.name}
                    </span>
                  ))}
                  <Badge tone="neutral">{card.stage.name}</Badge>
                </div>
              </>
            ) : (
              <span className="text-sm text-neutral-500">Loading…</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canDeleteCard ? (
              <button
                type="button"
                onClick={onDelete}
                disabled={deleteCardMutation.isPending || !card}
                className="rounded px-2 py-1 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
                title="Permanently delete this card"
              >
                {deleteCardMutation.isPending ? 'Deleting…' : 'Delete'}
              </button>
            ) : null}
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
              aria-label="Close"
            >
              Close
            </button>
          </div>
        </header>

        {cardQuery.isError ? (
          <div className="p-5 text-sm text-red-700">Could not load this card.</div>
        ) : null}

        {card ? (
          <div className="flex flex-col gap-5 px-5 py-4">
            {canWrite ? (
              <section>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Move
                </h3>
                <div className="flex flex-col gap-2">
                  {quickActions.length > 0 ? (
                    <QuickActionButtons
                      cardId={card.id}
                      currentStageId={card.stageId}
                      actions={quickActions}
                    />
                  ) : null}
                  <div className="max-w-xs">
                    <MoveCardMenu
                      cardId={card.id}
                      currentStageId={card.stageId}
                      stages={stages}
                      crossBoardStages={crossBoardStages}
                    />
                  </div>
                </div>
              </section>
            ) : null}

            <section>
              <div className="mb-1.5 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Description
                </h3>
                {canWrite && !editingDesc ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDescDraft(card.description ?? '')
                      setEditingDesc(true)
                    }}
                    className="text-xs text-primary-700 hover:underline"
                  >
                    {card.description ? 'Edit' : 'Add'}
                  </button>
                ) : null}
              </div>
              {editingDesc ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    rows={4}
                    value={descDraft}
                    maxLength={4000}
                    onChange={(e) => setDescDraft(e.target.value)}
                    className="rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm"
                    aria-label="Card description"
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingDesc(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={setDescription.isPending}
                      onClick={() =>
                        setDescription.mutate({
                          cardId: card.id,
                          description: descDraft.trim().length > 0 ? descDraft : null,
                        })
                      }
                    >
                      {setDescription.isPending ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                </div>
              ) : card.description ? (
                <p className="whitespace-pre-wrap break-words text-sm text-neutral-700">
                  {card.description}
                </p>
              ) : (
                <p className="text-sm text-neutral-500">No description yet.</p>
              )}
            </section>

            <CardSubtasks cardId={card.id} canWrite={canWrite} />

            <CallSummarySection cardId={card.id} canWrite={canWrite} />

            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Comments
              </h3>
              <CommentThread
                comments={comments}
                currentUserName={currentUserName}
                canComment={canComment}
                onAdd={async (body) => {
                  await addComment.mutateAsync({ cardId, body })
                  await utils.card.comments.list.invalidate({ cardId })
                  router.refresh()
                }}
              />
            </section>
          </div>
        ) : null}

        {card ? (
          <CardSidebar
            card={{
              id: card.id,
              contactId: card.contactId,
              contactName: card.contactName,
              contactEmail: card.contactEmail,
              contactPhone: card.contactPhone,
              stage: card.stage,
              board: card.board,
              assigneeId: card.assigneeId,
              assigneeName: card.assigneeName,
              assigneeEmail: card.assigneeEmail,
              dueAt: card.dueAt,
              scheduledCallAt: card.scheduledCallAt,
              priority: card.priority,
              labels: card.labels,
            }}
            canWrite={canWrite}
          />
        ) : null}
      </div>
    </div>
  )
}

