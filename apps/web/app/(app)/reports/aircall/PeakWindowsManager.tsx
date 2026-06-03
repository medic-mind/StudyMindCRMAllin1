// Manage the customisable Aircall peak-times windows (CLAUDE.md §10). Each
// window marks a season (month/day range), a set of weekdays, and an hour band
// as "peak". `year` = "Every year" (recurring) or a specific calendar year.
// Manager+ can add / edit / remove; everyone on the Reports surface sees the
// configured set with its call counts. Writes go through tRPC + router.refresh.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { PencilIcon, PlusIcon, Trash2Icon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

import { resolveStageColor } from '../../pipeline/stage-color'

interface WindowVM {
  id: string
  name: string
  startMonth: number
  startDay: number
  endMonth: number
  endDay: number
  daysOfWeek: ReadonlyArray<number>
  startHour: number
  endHour: number
  year: number | null
  color: string
  labels: { season: string; days: string; hours: string; year: string }
  calls: number
  answered: number
}

interface Props {
  windows: ReadonlyArray<WindowVM>
  canManage: boolean
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const COLORS = ['amber-500', 'rose-500', 'emerald-500', 'violet-600', 'sky-500', 'primary-600']

interface Draft {
  id: string | null
  name: string
  startMonth: number
  startDay: number
  endMonth: number
  endDay: number
  daysOfWeek: number[]
  startHour: number
  endHour: number
  year: number | null
  color: string
}

function blankDraft(): Draft {
  return {
    id: null,
    name: '',
    startMonth: 1,
    startDay: 1,
    endMonth: 12,
    endDay: 31,
    daysOfWeek: [0, 1, 2, 3, 4],
    startHour: 16,
    endHour: 20,
    year: null,
    color: 'amber-500',
  }
}

export function PeakWindowsManager({ windows, canManage }: Props) {
  const router = useRouter()
  const [draft, setDraft] = useState<Draft | null>(null)
  const utils = trpc.useUtils()

  function onDone(message: string) {
    toast.success(message)
    setDraft(null)
    void utils.reports.aircall.peakWindows.list.invalidate()
    router.refresh()
  }

  const create = trpc.reports.aircall.peakWindows.create.useMutation({
    onSuccess: () => onDone('Peak window added'),
    onError: (e) => toast.error(e.message ?? 'Could not save'),
  })
  const update = trpc.reports.aircall.peakWindows.update.useMutation({
    onSuccess: () => onDone('Peak window updated'),
    onError: (e) => toast.error(e.message ?? 'Could not save'),
  })
  const archive = trpc.reports.aircall.peakWindows.archive.useMutation({
    onSuccess: () => onDone('Peak window removed'),
    onError: (e) => toast.error(e.message ?? 'Could not remove'),
  })

  const saving = create.isPending || update.isPending

  function startEdit(w: WindowVM) {
    setDraft({
      id: w.id,
      name: w.name,
      startMonth: w.startMonth,
      startDay: w.startDay,
      endMonth: w.endMonth,
      endDay: w.endDay,
      daysOfWeek: [...w.daysOfWeek],
      startHour: w.startHour,
      endHour: w.endHour,
      year: w.year,
      color: w.color,
    })
  }

  function submit() {
    if (!draft) return
    if (!draft.name.trim()) {
      toast.error('Give the window a name')
      return
    }
    if (draft.daysOfWeek.length === 0) {
      toast.error('Pick at least one day')
      return
    }
    if (draft.endHour <= draft.startHour) {
      toast.error('End hour must be after the start hour')
      return
    }
    const payload = {
      name: draft.name.trim(),
      startMonth: draft.startMonth,
      startDay: draft.startDay,
      endMonth: draft.endMonth,
      endDay: draft.endDay,
      daysOfWeek: [...draft.daysOfWeek].sort((a, b) => a - b),
      startHour: draft.startHour,
      endHour: draft.endHour,
      year: draft.year,
      color: draft.color,
    }
    if (draft.id) update.mutate({ id: draft.id, ...payload })
    else create.mutate(payload)
  }

  const currentYear = new Date().getUTCFullYear()
  const yearOptions = [currentYear - 1, currentYear, currentYear + 1]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          Define the days and hours that count as “peak”. Seasonal windows recur every year
          unless you pin them to one. Calls are matched on UK time.
        </p>
        {canManage && !draft ? (
          <Button size="sm" variant="secondary" onClick={() => setDraft(blankDraft())}>
            <PlusIcon size={14} className="-ml-0.5 mr-1" />
            Add window
          </Button>
        ) : null}
      </div>

      {windows.length === 0 && !draft ? (
        <p className="rounded-lg border border-dashed border-neutral-200 px-4 py-6 text-center text-sm text-neutral-500">
          No peak windows yet. {canManage ? 'Add one to compare peak vs off-peak performance.' : 'Ask a manager to configure peak times.'}
        </p>
      ) : null}

      {windows.length > 0 ? (
        <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200">
          {windows.map((w) => (
            <li key={w.id} className="flex items-center gap-3 px-4 py-2.5">
              <span
                className="size-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: resolveStageColor(w.color) }}
                aria-hidden
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-neutral-900">{w.name}</div>
                <div className="text-xs text-neutral-500">
                  {w.labels.season} · {w.labels.days} · {w.labels.hours} · {w.labels.year}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-sm tabular-nums text-neutral-800">{w.calls}</div>
                <div className="text-[10px] uppercase tracking-wide text-neutral-400">calls</div>
              </div>
              {canManage ? (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => startEdit(w)}
                    aria-label={`Edit ${w.name}`}
                    className="rounded p-1.5 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
                  >
                    <PencilIcon size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Remove peak window “${w.name}”?`)) archive.mutate({ id: w.id })
                    }}
                    aria-label={`Remove ${w.name}`}
                    className="rounded p-1.5 text-neutral-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                  >
                    <Trash2Icon size={14} />
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {draft ? (
        <div className="space-y-3 rounded-lg border border-primary-200 bg-primary-50/40 p-4">
          <Field label="Name">
            <Input
              placeholder="e.g. Exam-season evenings"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Season start">
              <div className="flex gap-2">
                <Select
                  value={String(draft.startMonth)}
                  onChange={(e) => setDraft({ ...draft, startMonth: Number(e.target.value) })}
                >
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={draft.startDay}
                  onChange={(e) => setDraft({ ...draft, startDay: Number(e.target.value) })}
                  className="w-20"
                />
              </div>
            </Field>
            <Field label="Season end">
              <div className="flex gap-2">
                <Select
                  value={String(draft.endMonth)}
                  onChange={(e) => setDraft({ ...draft, endMonth: Number(e.target.value) })}
                >
                  {MONTHS.map((m, i) => (
                    <option key={m} value={i + 1}>
                      {m}
                    </option>
                  ))}
                </Select>
                <Input
                  type="number"
                  min={1}
                  max={31}
                  value={draft.endDay}
                  onChange={(e) => setDraft({ ...draft, endDay: Number(e.target.value) })}
                  className="w-20"
                />
              </div>
            </Field>
          </div>

          <Field label="Peak days" hint="Tap the days that are busy in this season">
            <div className="flex flex-wrap gap-1.5">
              {DOW.map((d, i) => {
                const on = draft.daysOfWeek.includes(i)
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() =>
                      setDraft({
                        ...draft,
                        daysOfWeek: on
                          ? draft.daysOfWeek.filter((x) => x !== i)
                          : [...draft.daysOfWeek, i],
                      })
                    }
                    className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                      on
                        ? 'border-primary-300 bg-primary-100 text-primary-800'
                        : 'border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50'
                    }`}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="From hour">
              <Select
                value={String(draft.startHour)}
                onChange={(e) => setDraft({ ...draft, startHour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }).map((_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="To hour" hint="Exclusive — 20:00 means up to 19:59">
              <Select
                value={String(draft.endHour)}
                onChange={(e) => setDraft({ ...draft, endHour: Number(e.target.value) })}
              >
                {Array.from({ length: 24 }).map((_, h) => (
                  <option key={h + 1} value={h + 1}>
                    {String(h + 1).padStart(2, '0')}:00
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Applies to">
              <Select
                value={draft.year == null ? 'every' : String(draft.year)}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    year: e.target.value === 'every' ? null : Number(e.target.value),
                  })
                }
              >
                <option value="every">Every year</option>
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y} only
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Colour">
              <div className="flex flex-wrap items-center gap-1.5 pt-1.5">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={c}
                    onClick={() => setDraft({ ...draft, color: c })}
                    className={`size-6 rounded-full ring-2 ring-offset-1 transition-transform ${
                      draft.color === c ? 'ring-neutral-800' : 'ring-transparent hover:scale-110'
                    }`}
                    style={{ backgroundColor: resolveStageColor(c) }}
                  />
                ))}
              </div>
            </Field>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving} onClick={submit}>
              {saving ? 'Saving…' : draft.id ? 'Save changes' : 'Add window'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
