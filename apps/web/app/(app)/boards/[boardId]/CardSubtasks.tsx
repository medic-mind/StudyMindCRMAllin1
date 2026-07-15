// Card sub-tasks — a Todoist-style checklist inside the card detail modal.
// Lightweight card-local checkboxes, distinct from CRM tasks. Add via the
// inline input, tick to complete, hover-to-delete. A progress count shows
// how many are done. CLAUDE.md §26.

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'
import { XIcon } from '@/components/ui/icon'

interface Props {
  cardId: string
  canWrite: boolean
}

export function CardSubtasks({ cardId, canWrite }: Props) {
  const utils = trpc.useUtils()
  const listQuery = trpc.card.subtasks.list.useQuery({ cardId })
  const [draft, setDraft] = useState('')

  const subtasks = listQuery.data ?? []
  const done = subtasks.filter((s) => s.completed).length

  const add = trpc.card.subtasks.add.useMutation({
    onSuccess: async () => {
      setDraft('')
      await utils.card.subtasks.list.invalidate({ cardId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not add sub-task'),
  })
  const update = trpc.card.subtasks.update.useMutation({
    onSuccess: async () => {
      await utils.card.subtasks.list.invalidate({ cardId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not update sub-task'),
  })
  const del = trpc.card.subtasks.delete.useMutation({
    onSuccess: async () => {
      await utils.card.subtasks.list.invalidate({ cardId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not delete sub-task'),
  })

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          Sub-tasks
        </h3>
        {subtasks.length > 0 && (
          <span className="text-[11px] tabular-nums text-neutral-500">
            {done}/{subtasks.length} done
          </span>
        )}
      </div>

      {subtasks.length > 0 && (
        <>
          {/* Progress bar — a thin visual cue of how complete the card is. */}
          <div className="mb-2 h-1 overflow-hidden rounded-full bg-neutral-100">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all"
              style={{ width: `${Math.round((done / subtasks.length) * 100)}%` }}
            />
          </div>
          <ul className="space-y-1">
            {subtasks.map((s) => (
              <li key={s.id} className="group flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={s.completed}
                  disabled={!canWrite || update.isPending}
                  onChange={(e) =>
                    update.mutate({ id: s.id, completed: e.target.checked })
                  }
                  className="h-4 w-4 shrink-0 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                />
                <span
                  className={`min-w-0 flex-1 truncate text-sm ${
                    s.completed ? 'text-neutral-400 line-through' : 'text-neutral-800'
                  }`}
                  title={s.title}
                >
                  {s.title}
                </span>
                {canWrite && (
                  <button
                    type="button"
                    onClick={() => del.mutate({ id: s.id })}
                    aria-label={`Delete sub-task "${s.title}"`}
                    className="shrink-0 text-xs text-neutral-300 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                  >
                    <XIcon size={14} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      {subtasks.length === 0 && !canWrite && (
        <p className="text-sm text-neutral-500">No sub-tasks.</p>
      )}

      {canWrite && (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const title = draft.trim()
            if (!title) return
            add.mutate({ cardId, title })
          }}
          className="mt-2 flex items-center gap-2"
        >
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={280}
            placeholder="Add a sub-task and press Enter…"
            className="flex-1 rounded border border-neutral-300 bg-white px-2 py-1 text-sm focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-200"
          />
          <button
            type="submit"
            disabled={add.isPending || draft.trim().length === 0}
            className="shrink-0 rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            Add
          </button>
        </form>
      )}
    </section>
  )
}
