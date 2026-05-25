// Board settings client UI. ADR 0018. CEO + Senior Manager (server gates).

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

import { resolveStageColor, STAGE_COLOR_OPTIONS } from '../../../pipeline/stage-color'

interface Stage {
  id: string
  name: string
  position: number
  color: string
  isClosed: boolean
}
interface Label {
  id: string
  name: string
  color: string
}
interface Board {
  id: string
  name: string
  description: string | null
  tickActionStageId: string | null
  xActionStageId: string | null
}

interface Props {
  board: Board
  stages: ReadonlyArray<Stage>
  labels: ReadonlyArray<Label>
}

export function BoardSettings({ board, stages, labels }: Props) {
  const router = useRouter()
  const refresh = () => router.refresh()

  // --- Rename board ---
  const [name, setName] = useState(board.name)
  const [description, setDescription] = useState(board.description ?? '')
  const updateBoard = trpc.board.update.useMutation({
    onSuccess: () => {
      toast.success('Board updated')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  // --- Quick actions ---
  const [tickStageId, setTickStageId] = useState(board.tickActionStageId ?? '')
  const [xStageId, setXStageId] = useState(board.xActionStageId ?? '')
  const setQuickActions = trpc.board.setQuickActions.useMutation({
    onSuccess: () => {
      toast.success('Quick actions saved')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  // --- Stages ---
  const [newStageName, setNewStageName] = useState('')
  const [newStageColor, setNewStageColor] = useState(STAGE_COLOR_OPTIONS[0]!.token)
  const createStage = trpc.board.stages.create.useMutation({
    onSuccess: () => {
      toast.success('Stage added')
      setNewStageName('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })
  const archiveStage = trpc.board.stages.archive.useMutation({
    onSuccess: () => {
      toast.success('Stage archived')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  // --- Labels ---
  const [newLabelName, setNewLabelName] = useState('')
  const [newLabelColor, setNewLabelColor] = useState(STAGE_COLOR_OPTIONS[0]!.token)
  const createLabel = trpc.label.create.useMutation({
    onSuccess: () => {
      toast.success('Label created')
      setNewLabelName('')
      refresh()
    },
    onError: (e) => toast.error(e.message),
  })

  return (
    <div className="flex flex-col gap-8">
      {/* Rename */}
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-800">Board details</h2>
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            updateBoard.mutate({
              id: board.id,
              name: name.trim(),
              description: description.trim() || null,
            })
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            maxLength={500}
          />
          <div>
            <Button type="submit" size="sm" disabled={updateBoard.isPending}>
              Save
            </Button>
          </div>
        </form>
      </section>

      {/* Stages */}
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-800">Stages</h2>
        <ul className="mt-3 divide-y divide-neutral-100">
          {stages.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className="flex items-center gap-2">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: resolveStageColor(s.color) }}
                  aria-hidden
                />
                {s.name}
                {s.isClosed ? <span className="text-xs text-neutral-500">(closed)</span> : null}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={archiveStage.isPending}
                onClick={() => archiveStage.mutate({ id: s.id })}
              >
                Archive
              </Button>
            </li>
          ))}
        </ul>
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newStageName.trim()) {
              toast.error('Stage name is required')
              return
            }
            createStage.mutate({
              boardId: board.id,
              name: newStageName.trim(),
              color: newStageColor,
            })
          }}
        >
          <label className="flex-1 text-xs">
            <span className="mb-1 block font-medium text-neutral-700">New stage</span>
            <Input value={newStageName} onChange={(e) => setNewStageName(e.target.value)} />
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-neutral-700">Colour</span>
            <Select value={newStageColor} onChange={(e) => setNewStageColor(e.target.value)}>
              {STAGE_COLOR_OPTIONS.map((o) => (
                <option key={o.token} value={o.token}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" size="sm" disabled={createStage.isPending}>
            Add
          </Button>
        </form>
      </section>

      {/* Quick actions */}
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-800">Quick actions</h2>
        <p className="mt-1 text-xs text-neutral-600">
          The tick and cross buttons on a card move it to these stages (used in a later slice).
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          <label className="text-xs">
            <span className="mb-1 block font-medium text-neutral-700">Tick → stage</span>
            <Select value={tickStageId} onChange={(e) => setTickStageId(e.target.value)}>
              <option value="">None</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-neutral-700">Cross → stage</span>
            <Select value={xStageId} onChange={(e) => setXStageId(e.target.value)}>
              <option value="">None</option>
              {stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
          <div className="flex items-end">
            <Button
              size="sm"
              disabled={setQuickActions.isPending}
              onClick={() =>
                setQuickActions.mutate({
                  boardId: board.id,
                  tickStageId: tickStageId || null,
                  xStageId: xStageId || null,
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </section>

      {/* Labels */}
      <section className="rounded-lg border border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-800">Labels</h2>
        <div className="mt-3 flex flex-wrap gap-1">
          {labels.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium text-white"
              style={{ backgroundColor: resolveStageColor(l.color) }}
            >
              {l.name}
            </span>
          ))}
        </div>
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!newLabelName.trim()) {
              toast.error('Label name is required')
              return
            }
            createLabel.mutate({ name: newLabelName.trim(), color: newLabelColor })
          }}
        >
          <label className="flex-1 text-xs">
            <span className="mb-1 block font-medium text-neutral-700">New label</span>
            <Input value={newLabelName} onChange={(e) => setNewLabelName(e.target.value)} />
          </label>
          <label className="text-xs">
            <span className="mb-1 block font-medium text-neutral-700">Colour</span>
            <Select value={newLabelColor} onChange={(e) => setNewLabelColor(e.target.value)}>
              {STAGE_COLOR_OPTIONS.map((o) => (
                <option key={o.token} value={o.token}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
          <Button type="submit" size="sm" disabled={createLabel.isPending}>
            Add
          </Button>
        </form>
      </section>
    </div>
  )
}
