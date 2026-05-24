// Stage manager: rename, recolor, reorder, mark closed, archive, restore.
// Client leaf. ADR 0015. CLAUDE.md §3 (no drag — explicit arrows + confirm).

'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

import { STAGE_COLOR_OPTIONS, resolveStageColor } from '../stage-color'

interface ActiveStage {
  id: string
  name: string
  position: number
  color: string
  isClosed: boolean
}

interface ArchivedStage {
  id: string
  name: string
  color: string
  isClosed: boolean
}

interface Props {
  active: ReadonlyArray<ActiveStage>
  archived: ReadonlyArray<ArchivedStage>
}

export function ManageStagesTable({ active, archived }: Props) {
  const router = useRouter()

  const update = trpc.pipeline.stages.update.useMutation({
    onSuccess: () => {
      toast.success('Stage updated')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not update stage'),
  })
  const reorder = trpc.pipeline.stages.reorder.useMutation({
    onSuccess: () => {
      toast.success('Stages reordered')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not reorder'),
  })
  const archive = trpc.pipeline.stages.archive.useMutation({
    onSuccess: (data) => {
      toast.success(
        data.reassigned > 0
          ? `Archived. ${data.reassigned} families reassigned.`
          : 'Stage archived.',
      )
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not archive'),
  })
  const restore = trpc.pipeline.stages.restore.useMutation({
    onSuccess: () => {
      toast.success('Stage restored')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not restore'),
  })

  function moveStage(id: string, direction: 'up' | 'down') {
    const ids = active.map((s) => s.id)
    const idx = ids.indexOf(id)
    if (idx < 0) return
    const swapWith = direction === 'up' ? idx - 1 : idx + 1
    if (swapWith < 0 || swapWith >= ids.length) return
    const next = [...ids]
    const a = next[idx]!
    const b = next[swapWith]!
    next[idx] = b
    next[swapWith] = a
    reorder.mutate({ orderedIds: next })
  }

  return (
    <div className="space-y-8">
      <section>
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-600">
          Active stages
        </h2>
        {active.length === 0 ? (
          <p className="rounded-md border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
            No active stages yet — add one below to get started.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-white">
            {active.map((stage, idx) => (
              <li key={stage.id} className="flex flex-wrap items-center gap-3 p-3">
                <span
                  className="inline-block size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: resolveStageColor(stage.color) }}
                  aria-hidden
                />
                <span className="min-w-12 font-mono text-xs tabular-nums text-neutral-500">
                  #{stage.position}
                </span>
                <StageNameField
                  initial={stage.name}
                  onSave={(name) => update.mutate({ id: stage.id, name })}
                />
                <ColorPicker
                  value={stage.color}
                  onChange={(color) => update.mutate({ id: stage.id, color })}
                />
                <label className="flex items-center gap-1 text-xs text-neutral-700">
                  <input
                    type="checkbox"
                    checked={stage.isClosed}
                    onChange={(e) =>
                      update.mutate({ id: stage.id, isClosed: e.target.checked })
                    }
                  />
                  Closed
                </label>
                <div className="ml-auto flex items-center gap-1">
                  <button
                    type="button"
                    disabled={idx === 0 || reorder.isPending}
                    onClick={() => moveStage(stage.id, 'up')}
                    aria-label={`Move ${stage.name} up`}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={idx === active.length - 1 || reorder.isPending}
                    onClick={() => moveStage(stage.id, 'down')}
                    aria-label={`Move ${stage.name} down`}
                    className="rounded border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 disabled:opacity-30"
                  >
                    ↓
                  </button>
                  <ArchiveButton
                    stageId={stage.id}
                    stageName={stage.name}
                    otherStages={active.filter((s) => s.id !== stage.id)}
                    onArchive={(reassignFamiliesTo) =>
                      archive.mutate({
                        id: stage.id,
                        reassignFamiliesTo,
                      })
                    }
                    pending={archive.isPending}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <CreateStageForm />

      {archived.length > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-600">
            Archived stages
          </h2>
          <ul className="divide-y divide-neutral-100 rounded-md border border-neutral-200 bg-neutral-50">
            {archived.map((stage) => (
              <li key={stage.id} className="flex items-center gap-3 p-3 text-sm">
                <span
                  className="inline-block size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: resolveStageColor(stage.color) }}
                  aria-hidden
                />
                <span className="text-neutral-700">{stage.name}</span>
                {stage.isClosed ? (
                  <span className="rounded bg-neutral-200 px-1.5 py-0.5 text-[10px] uppercase text-neutral-700">
                    Closed
                  </span>
                ) : null}
                <div className="ml-auto">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate({ id: stage.id })}
                  >
                    Restore
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function StageNameField({
  initial,
  onSave,
}: {
  initial: string
  onSave: (name: string) => void
}) {
  const [value, setValue] = useState(initial)
  const dirty = value.trim() !== initial && value.trim().length > 0
  return (
    <span className="flex items-center gap-1">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-44 rounded border border-neutral-300 px-2 py-1 text-sm"
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={!dirty}
        onClick={() => onSave(value.trim())}
      >
        Rename
      </Button>
    </span>
  )
}

function ColorPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (color: string) => void
}) {
  return (
    <span className="flex items-center gap-1">
      {STAGE_COLOR_OPTIONS.map((opt) => {
        const active = opt.token === value
        return (
          <button
            key={opt.token}
            type="button"
            aria-label={`Set colour to ${opt.label}`}
            aria-pressed={active}
            onClick={() => onChange(opt.token)}
            className={
              active
                ? 'size-5 rounded-full ring-2 ring-neutral-900 ring-offset-1'
                : 'size-5 rounded-full ring-1 ring-neutral-300 hover:ring-neutral-500'
            }
            style={{ backgroundColor: opt.hex }}
          />
        )
      })}
    </span>
  )
}

function ArchiveButton({
  stageId: _stageId,
  stageName,
  otherStages,
  onArchive,
  pending,
}: {
  stageId: string
  stageName: string
  otherStages: ReadonlyArray<ActiveStage>
  onArchive: (reassignFamiliesTo: string | undefined) => void
  pending: boolean
}) {
  const [open, setOpen] = useState(false)
  const [reassignTo, setReassignTo] = useState<string>('')

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() => setOpen(true)}
      >
        Archive
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs">
      <span>Reassign families to:</span>
      <select
        value={reassignTo}
        onChange={(e) => setReassignTo(e.target.value)}
        className="rounded border border-neutral-300 bg-white px-1 py-0.5"
        aria-label={`Reassignment target for ${stageName}`}
      >
        <option value="">(none — only allowed if empty)</option>
        {otherStages.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        disabled={pending}
        onClick={() => {
          onArchive(reassignTo || undefined)
          setOpen(false)
        }}
      >
        Confirm
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  )
}

function CreateStageForm() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [color, setColor] = useState(STAGE_COLOR_OPTIONS[0]!.token)
  const [isClosed, setIsClosed] = useState(false)

  const create = trpc.pipeline.stages.create.useMutation({
    onSuccess: () => {
      toast.success(`Stage "${name}" added`)
      setName('')
      setIsClosed(false)
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not add stage'),
  })

  const canSubmit = useMemo(() => name.trim().length > 0, [name])

  return (
    <section className="rounded-md border border-neutral-200 bg-white p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-600">
        Add a new stage
      </h2>
      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!canSubmit) return
          create.mutate({ name: name.trim(), color, isClosed })
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-neutral-700">
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-56 rounded border border-neutral-300 px-2 py-1 text-sm"
            placeholder="e.g. Renewal pending"
            required
          />
        </label>
        <fieldset className="flex flex-col gap-1 text-xs text-neutral-700">
          <legend>Colour</legend>
          <ColorPicker value={color} onChange={setColor} />
        </fieldset>
        <label className="flex items-center gap-1 text-xs text-neutral-700">
          <input
            type="checkbox"
            checked={isClosed}
            onChange={(e) => setIsClosed(e.target.checked)}
          />
          Closed stage
        </label>
        <Button type="submit" disabled={!canSubmit || create.isPending}>
          {create.isPending ? 'Adding…' : 'Add stage'}
        </Button>
      </form>
    </section>
  )
}
