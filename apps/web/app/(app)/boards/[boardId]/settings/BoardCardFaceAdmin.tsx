// Card-face config (UI roadmap increment 4). Manager+ chooses which preview
// fields show on every card on this board — declutter a call-scheduling board
// to just the name + scheduled call, or show everything. No code change.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card'
import { CARD_FACE_FIELDS, type CardFaceKey } from '@/lib/board/card-face'
import { trpc } from '@/lib/trpc/client'

export function BoardCardFaceAdmin({
  boardId,
  initialFields,
}: {
  boardId: string
  /** null = show all (no explicit config yet). */
  initialFields: CardFaceKey[] | null
}) {
  const router = useRouter()
  // null config means "all on" — seed the checklist accordingly.
  const [enabled, setEnabled] = useState<Set<CardFaceKey>>(
    () =>
      new Set<CardFaceKey>(
        initialFields ?? CARD_FACE_FIELDS.map((f) => f.key),
      ),
  )
  const save = trpc.board.setCardFields.useMutation({
    onSuccess: () => {
      toast.success('Card layout saved')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not save'),
  })

  function toggle(key: CardFaceKey, on: boolean) {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })
  }

  const allOn = enabled.size === CARD_FACE_FIELDS.length

  return (
    <Card>
      <CardHeader>
        <CardTitle>Card layout</CardTitle>
      </CardHeader>
      <CardBody>
        <p className="mb-3 text-sm text-neutral-600">
          Choose which fields appear on every card on this board. The contact name is
          always shown. Turn things off to keep a busy board scannable.
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CARD_FACE_FIELDS.map((f) => (
            <label
              key={f.key}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
            >
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                checked={enabled.has(f.key)}
                onChange={(e) => toggle(f.key, e.target.checked)}
              />
              {f.label}
            </label>
          ))}
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={save.isPending}
            onClick={() =>
              save.mutate({ boardId, fields: Array.from(enabled) })
            }
          >
            {save.isPending ? 'Saving…' : 'Save layout'}
          </Button>
          <span className="text-xs text-neutral-500">
            {allOn ? 'Showing all fields' : `${enabled.size} of ${CARD_FACE_FIELDS.length} fields shown`}
          </span>
        </div>
      </CardBody>
    </Card>
  )
}
