// Clear the whole board in one audited action — every live card is soft-archived
// (reversible mechanics; customers + their history untouched). CEO-only (server
// enforces via card.clearBoard). Because it archives everything at once it is
// double-verified: the operator must SOLVE A PUZZLE (a random sum) AND type the
// board's exact name before the Clear button arms. The server independently
// re-checks the typed name. CLAUDE.md §3 (destructive bulk actions confirm).

'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { trpc } from '@/lib/trpc/client'

/** A fresh little arithmetic puzzle — the "are you REALLY sure" gate. */
function makePuzzle(): { a: number; b: number; answer: number } {
  const a = Math.floor(Math.random() * 8) + 2 // 2..9
  const b = Math.floor(Math.random() * 8) + 2 // 2..9
  return { a, b, answer: a + b }
}

export function ClearBoardButton({
  boardId,
  boardName,
  cardCount,
}: {
  boardId: string
  boardName: string
  cardCount: number
}): JSX.Element | null {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [open, setOpen] = useState(false)
  // A new puzzle each time the dialog opens.
  const [puzzleSeed, setPuzzleSeed] = useState(0)
  const puzzle = useMemo(() => makePuzzle(), [puzzleSeed])
  const [answer, setAnswer] = useState('')
  const [nameInput, setNameInput] = useState('')

  const clear = trpc.card.clearBoard.useMutation({
    onSuccess: async (r) => {
      const n = r?.archived ?? 0
      toast.success(`Board cleared — ${n} card${n === 1 ? '' : 's'} archived.`)
      setOpen(false)
      await utils.card.list.invalidate()
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not clear the board'),
  })

  if (cardCount === 0) return null

  const puzzleSolved = answer.trim() === String(puzzle.answer)
  const nameMatches = nameInput.trim().toLowerCase() === boardName.trim().toLowerCase()
  const armed = puzzleSolved && nameMatches && !clear.isPending

  function openDialog() {
    setPuzzleSeed((s) => s + 1)
    setAnswer('')
    setNameInput('')
    setOpen(true)
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        onClick={openDialog}
        className="text-red-700 hover:bg-red-50"
      >
        Clear board
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} size="md" title={`Clear "${boardName}"?`}>
        <div className="space-y-4">
          <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            All <span className="font-semibold tabular-nums">{cardCount}</span> card
            {cardCount === 1 ? '' : 's'} on this board will be archived in one go. Customers and
            their timeline history are untouched, stages/labels/quick-actions stay, and the action
            is recorded in the audit log — but this clears the whole board.
          </div>

          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
            Double verification
          </p>

          <Field label={`Puzzle — what is ${puzzle.a} + ${puzzle.b}?`} htmlFor="clear-board-puzzle">
            <Input
              id="clear-board-puzzle"
              inputMode="numeric"
              autoComplete="off"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="Answer"
            />
          </Field>

          <Field
            label={`Type the board name to confirm — "${boardName}"`}
            htmlFor="clear-board-name"
          >
            <Input
              id="clear-board-name"
              autoComplete="off"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={boardName}
            />
          </Field>

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!armed}
              onClick={() => clear.mutate({ boardId, confirmation: nameInput.trim() })}
              className="bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {clear.isPending ? 'Clearing…' : 'Clear board'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
