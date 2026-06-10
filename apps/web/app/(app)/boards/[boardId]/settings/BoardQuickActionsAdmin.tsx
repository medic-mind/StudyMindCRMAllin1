// Quick-actions catalogue admin for a single board. Each row creates a
// button that appears on every card on the board — clicking it fires the
// action's comment template + moves the card to the action's target stage
// (possibly on a different board). Manager+ from the tRPC layer.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

import { resolveStageColor } from '../../../pipeline/stage-color'

interface Stage {
  id: string
  name: string
  boardId: string
  boardName: string
}

interface QuickAction {
  id: string
  boardId: string
  label: string
  color: string | null
  targetStageId: string
  targetBoardId: string | null
  targetStageName: string
  targetBoardName: string | null
  commentTemplate: string | null
  sortOrder: number
  archived: boolean
}

interface Props {
  boardId: string
  /** Every active stage across every active board — used so the picker
   * can route a quick action to another pipeline. */
  allStages: ReadonlyArray<Stage>
}

const DEFAULT_COLORS = [
  '#10b981', // emerald
  '#f59e0b', // amber
  '#f97316', // orange
  '#ef4444', // red
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#64748b', // slate
]

export function BoardQuickActionsAdmin({ boardId, allStages }: Props) {
  const router = useRouter()
  const listQuery = trpc.boardQuickAction.list.useQuery({
    boardId,
    includeArchived: true,
  })
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const actions = (listQuery.data ?? []) as QuickAction[]

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-neutral-900">Quick-action buttons</h2>
          <p className="mt-1 text-xs text-neutral-500">
            Each button appears on every card on this board. Click adds the comment template and
            moves the card to the target stage — the target can sit on a different board, useful for
            routing a completed call into a follow-up pipeline.
          </p>
        </div>
        {!creating && (
          <Button type="button" size="sm" onClick={() => setCreating(true)}>
            + New action
          </Button>
        )}
      </div>

      {creating && (
        <QuickActionEditor
          mode="create"
          boardId={boardId}
          allStages={allStages}
          onClose={() => setCreating(false)}
          onSaved={async () => {
            setCreating(false)
            await listQuery.refetch()
            router.refresh()
          }}
        />
      )}

      {listQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : actions.length === 0 ? (
        <p className="text-sm text-neutral-600">
          No quick actions yet. Click <em>+ New action</em> to add one (e.g. Called once → Called
          once stage).
        </p>
      ) : (
        <ul className="space-y-2">
          {actions.map((a) =>
            editingId === a.id ? (
              <li key={a.id}>
                <QuickActionEditor
                  mode="edit"
                  boardId={boardId}
                  action={a}
                  allStages={allStages}
                  onClose={() => setEditingId(null)}
                  onSaved={async () => {
                    setEditingId(null)
                    await listQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ) : (
              <li key={a.id} className="rounded-md border border-neutral-200 bg-white p-3 text-sm">
                <QuickActionRow
                  action={a}
                  onEdit={() => setEditingId(a.id)}
                  onChanged={async () => {
                    await listQuery.refetch()
                    router.refresh()
                  }}
                />
              </li>
            ),
          )}
        </ul>
      )}
    </section>
  )
}

function QuickActionRow({
  action,
  onEdit,
  onChanged,
}: {
  action: QuickAction
  onEdit: () => void
  onChanged: () => Promise<void>
}) {
  const archive = trpc.boardQuickAction.archive.useMutation()
  const restore = trpc.boardQuickAction.restore.useMutation()
  const [busy, setBusy] = useState(false)

  async function toggleArchive() {
    setBusy(true)
    try {
      if (action.archived) {
        await restore.mutateAsync({ id: action.id })
        toast.success('Action restored')
      } else {
        await archive.mutateAsync({ id: action.id })
        toast.success('Action archived')
      }
      await onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold text-white"
            style={{ backgroundColor: resolveStageColor(action.color ?? '#64748b') }}
          >
            {action.label}
          </span>
          <span className="text-xs text-neutral-600">
            → <strong className="text-neutral-800">{action.targetStageName}</strong>
            {action.targetBoardName ? (
              <span className="text-neutral-500"> on {action.targetBoardName}</span>
            ) : null}
          </span>
          {action.archived && (
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-600">
              Archived
            </span>
          )}
        </div>
        {action.commentTemplate ? (
          <p className="mt-1 text-xs text-neutral-600">
            <span className="font-medium text-neutral-700">Comment:</span> {action.commentTemplate}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="text-xs text-neutral-700 hover:underline"
        >
          Edit
        </button>
        <button
          type="button"
          onClick={toggleArchive}
          disabled={busy}
          className="text-xs text-neutral-600 hover:underline"
        >
          {action.archived ? 'Restore' : 'Archive'}
        </button>
      </div>
    </div>
  )
}

function QuickActionEditor({
  mode,
  boardId,
  action,
  allStages,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit'
  boardId: string
  action?: QuickAction
  allStages: ReadonlyArray<Stage>
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [label, setLabel] = useState(action?.label ?? '')
  const [color, setColor] = useState(action?.color ?? DEFAULT_COLORS[0]!)
  const [targetStageId, setTargetStageId] = useState(action?.targetStageId ?? '')
  const [commentTemplate, setCommentTemplate] = useState(action?.commentTemplate ?? '')
  const [sortOrder, setSortOrder] = useState(action?.sortOrder ?? 100)
  const [busy, setBusy] = useState(false)

  const create = trpc.boardQuickAction.create.useMutation()
  const update = trpc.boardQuickAction.update.useMutation()

  // Group stages by board for the picker.
  const groupedStages = new Map<string, { boardName: string; stages: Stage[] }>()
  for (const s of allStages) {
    const g = groupedStages.get(s.boardId) ?? { boardName: s.boardName, stages: [] }
    g.stages.push(s)
    groupedStages.set(s.boardId, g)
  }

  async function save() {
    if (!label.trim() || !targetStageId) {
      toast.error('Label and target stage are required.')
      return
    }
    setBusy(true)
    try {
      if (mode === 'create') {
        await create.mutateAsync({
          boardId,
          label: label.trim(),
          color,
          targetStageId,
          commentTemplate: commentTemplate.trim() || undefined,
          sortOrder,
        })
        toast.success('Action created')
      } else if (action) {
        await update.mutateAsync({
          id: action.id,
          label: label.trim(),
          color,
          targetStageId,
          commentTemplate: commentTemplate.trim() || null,
          sortOrder,
        })
        toast.success('Action updated')
      }
      await onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/30 p-4 shadow-card">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-900">
          {mode === 'create' ? 'New quick action' : `Edit: ${action?.label}`}
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-neutral-500 hover:underline"
        >
          Close
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Label">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Called once"
          />
        </Field>
        <Field label="Colour">
          <div className="flex flex-wrap items-center gap-1.5">
            {DEFAULT_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Pick ${c}`}
                onClick={() => setColor(c)}
                className={
                  color === c
                    ? 'h-6 w-6 rounded-full ring-2 ring-offset-1 ring-primary-500'
                    : 'h-6 w-6 rounded-full ring-1 ring-neutral-200'
                }
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </Field>
        <Field label="Target stage (board)" wide>
          <Select value={targetStageId} onChange={(e) => setTargetStageId(e.target.value)}>
            <option value="">— Select stage —</option>
            {Array.from(groupedStages.values()).map((g) => (
              <optgroup key={g.boardName} label={g.boardName}>
                {g.stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </Field>
        <Field label="Sort order">
          <Input
            type="number"
            min={0}
            max={10000}
            value={sortOrder}
            onChange={(e) => setSortOrder(Number(e.target.value) || 0)}
          />
        </Field>
      </div>
      <Field label="Comment template (added to the card timeline)">
        <Textarea
          rows={3}
          value={commentTemplate}
          onChange={(e) => setCommentTemplate(e.target.value)}
          placeholder="e.g. Called twice — no answer / left voicemail."
        />
      </Field>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button type="button" onClick={save} disabled={busy || !label.trim() || !targetStageId}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-neutral-600 hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function Field({
  label,
  wide,
  children,
}: {
  label: string
  wide?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </label>
      <div className="mt-1">{children}</div>
    </div>
  )
}
