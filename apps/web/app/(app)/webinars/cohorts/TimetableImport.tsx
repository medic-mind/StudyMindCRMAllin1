'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

interface PlanClass {
  subjectHandle: string
  subjectLabel: string
  subjectIsNew: boolean
  levelHandle: string
  levelLabel: string
  levelIsNew: boolean
  title: string
  dayOfWeek: number
  startMinute: number
  durationMins: number
  weeks: Array<{ weekNumber: number; topic: string }>
  keep: boolean
}
interface PlanHoliday {
  name: string
  startsOn: string
  endsOn: string
  keep: boolean
}

function minuteToHHMM(minute: number): string {
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
function hhmmToMinute(value: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!m) return 0
  return Math.min(1439, Number(m[1]) * 60 + Number(m[2]))
}

export function TimetableImport() {
  const router = useRouter()
  const utils = trpc.useUtils()

  const [kind, setKind] = useState<'text' | 'csv' | 'pdf'>('pdf')
  const [text, setText] = useState('')
  const [note, setNote] = useState('')
  const [hasPlan, setHasPlan] = useState(false)
  const [cohortName, setCohortName] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')
  const [status, setStatus] = useState<'planning' | 'active'>('planning')
  const [classes, setClasses] = useState<PlanClass[]>([])
  const [holidays, setHolidays] = useState<PlanHoliday[]>([])

  const preview = trpc.webinar.timetable.importPreview.useMutation({
    onSuccess: (r) => {
      setNote(r.note)
      setHasPlan(true)
      setCohortName(r.cohort.name)
      setStartsOn(r.cohort.startsOn ?? '')
      setEndsOn(r.cohort.endsOn ?? '')
      setHolidays(r.holidays.map((h) => ({ ...h, keep: true })))
      setClasses(r.classes.map((c) => ({ ...c, keep: true })))
      if (r.classes.length === 0) toast.error(r.note)
    },
    onError: (e) => toast.error(e.message),
  })

  const apply = trpc.webinar.timetable.apply.useMutation({
    onSuccess: async (r) => {
      toast.success(
        `${r.cohortCreated ? 'Cohort created' : 'Cohort updated'} · ${r.classesCreated} classes · ${r.weeksSet} weekly topics`,
      )
      await utils.webinar.cohort.list.invalidate()
      reset()
      router.push(`/webinars/cohorts/${r.cohortId}`)
    },
    onError: (e) => toast.error(e.message),
  })

  function reset() {
    setHasPlan(false)
    setText('')
    setNote('')
    setCohortName('')
    setStartsOn('')
    setEndsOn('')
    setClasses([])
    setHolidays([])
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const buf = await file.arrayBuffer()
    let binary = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    preview.mutate({ kind, dataBase64: btoa(binary) })
    e.target.value = ''
  }

  function submit() {
    const keptClasses = classes.filter((c) => c.keep)
    if (!cohortName.trim()) {
      toast.error('Give the academic year a name (e.g. 2026/2027).')
      return
    }
    if (!startsOn || !endsOn) {
      toast.error('Set the term start and end dates.')
      return
    }
    if (keptClasses.length === 0) {
      toast.error('Keep at least one class to create.')
      return
    }
    apply.mutate({
      cohort: { name: cohortName.trim(), startsOn, endsOn, status },
      holidays: holidays
        .filter((h) => h.keep && h.name.trim() && h.startsOn && h.endsOn)
        .map((h) => ({ name: h.name.trim(), startsOn: h.startsOn, endsOn: h.endsOn })),
      classes: keptClasses.map((c) => ({
        subjectHandle: c.subjectHandle,
        subjectLabel: c.subjectLabel,
        levelHandle: c.levelHandle,
        levelLabel: c.levelLabel,
        title: c.title.trim() || `${c.subjectLabel} ${c.levelLabel}`,
        dayOfWeek: c.dayOfWeek,
        startMinute: c.startMinute,
        durationMins: c.durationMins,
        weeks: c.weeks,
      })),
    })
  }

  const keepCount = classes.filter((c) => c.keep).length

  return (
    <Card>
      <CardBody>
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Import a timetable (AI)</h2>
            <p className="mt-1 max-w-2xl text-xs text-neutral-500">
              Upload your weekly group-class timetable (PDF), or paste it. The app reads it with AI
              and builds the <strong>academic year, its holidays, and every class</strong> (subject,
              level, day, time and weekly topics) for you to review. Nothing is created until you
              confirm — then just fill in the Zoom links.
            </p>
          </div>
          {hasPlan ? (
            <Button size="sm" variant="ghost" onClick={reset}>
              Start over
            </Button>
          ) : null}
        </div>

        {!hasPlan ? (
          <>
            <div className="mt-3 flex gap-1">
              {(['pdf', 'csv', 'text'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={
                    'rounded-md px-3 py-1.5 text-sm ' +
                    (kind === k
                      ? 'bg-primary-50 font-medium text-primary-800'
                      : 'text-neutral-600 hover:bg-neutral-100')
                  }
                >
                  {k === 'text' ? 'Paste' : k.toUpperCase()}
                </button>
              ))}
            </div>

            {kind === 'text' ? (
              <div className="mt-2 space-y-2">
                <Textarea
                  rows={8}
                  placeholder={
                    'Paste the full timetable — e.g.\nBiology A-Level — Saturdays 6pm\n  Week 1: Cells\n  Week 2: Transport\nChemistry GCSE — Tuesdays 5pm\n…'
                  }
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button
                  size="sm"
                  disabled={preview.isPending || text.trim().length === 0}
                  onClick={() => preview.mutate({ kind: 'text', text })}
                >
                  {preview.isPending ? 'Reading…' : 'Read timetable'}
                </Button>
              </div>
            ) : (
              <div className="mt-3">
                <label className="inline-flex">
                  <span className="inline-flex h-9 cursor-pointer items-center rounded-md border border-neutral-200 bg-white px-3 text-sm text-neutral-800 shadow-sm hover:bg-neutral-50">
                    {preview.isPending ? 'Reading…' : `Choose ${kind.toUpperCase()} file`}
                  </span>
                  <input
                    type="file"
                    accept={kind === 'pdf' ? 'application/pdf' : '.csv,text/csv,text/plain'}
                    className="hidden"
                    onChange={onFile}
                  />
                </label>
              </div>
            )}
          </>
        ) : (
          <div className="mt-4 space-y-5">
            {note ? <p className="text-xs text-neutral-500">{note}</p> : null}

            {/* Cohort */}
            <div className="grid gap-3 md:grid-cols-4">
              <Field label="Academic year" htmlFor="tt-name">
                <Input
                  id="tt-name"
                  placeholder="2026/2027"
                  value={cohortName}
                  onChange={(e) => setCohortName(e.target.value)}
                />
              </Field>
              <Field label="Starts" htmlFor="tt-start">
                <Input id="tt-start" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
              </Field>
              <Field label="Ends" htmlFor="tt-end">
                <Input id="tt-end" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
              </Field>
              <Field label="Status" htmlFor="tt-status" hint="Emails only send when active.">
                <Select
                  id="tt-status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value as 'planning' | 'active')}
                >
                  <option value="planning">Planning</option>
                  <option value="active">Active</option>
                </Select>
              </Field>
            </div>

            {/* Classes */}
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Classes ({keepCount} of {classes.length})
              </h3>
              {classes.length === 0 ? (
                <p className="text-sm text-neutral-500">
                  No classes were detected. Try a clearer PDF or paste the timetable.
                </p>
              ) : (
                <div className="space-y-2">
                  {classes.map((c, i) => (
                    <div
                      key={`${c.subjectHandle}-${c.levelHandle}-${i}`}
                      className={
                        'rounded-md border p-3 ' +
                        (c.keep ? 'border-neutral-200 bg-white' : 'border-neutral-200 bg-neutral-50 opacity-60')
                      }
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Checkbox
                          checked={c.keep}
                          onChange={(e) => {
                            const next = [...classes]
                            next[i] = { ...c, keep: e.target.checked }
                            setClasses(next)
                          }}
                          aria-label={`Include ${c.subjectLabel} ${c.levelLabel}`}
                        />
                        <span className="text-sm font-medium text-neutral-900">
                          {c.subjectLabel} {c.levelLabel}
                        </span>
                        {c.subjectIsNew ? <Badge tone="info">New subject</Badge> : null}
                        {c.levelIsNew ? <Badge tone="info">New level</Badge> : null}
                        <Badge tone="neutral">{c.weeks.length} weeks</Badge>
                      </div>
                      <div className="mt-2 grid gap-2 md:grid-cols-[1fr_auto_auto]">
                        <Input
                          value={c.title}
                          onChange={(e) => {
                            const next = [...classes]
                            next[i] = { ...c, title: e.target.value }
                            setClasses(next)
                          }}
                          placeholder="Class title"
                        />
                        <Select
                          value={c.dayOfWeek}
                          onChange={(e) => {
                            const next = [...classes]
                            next[i] = { ...c, dayOfWeek: Number(e.target.value) }
                            setClasses(next)
                          }}
                          aria-label="Day of week"
                        >
                          {DAY_LABELS.map((d, idx) => (
                            <option key={d} value={idx}>
                              {d}
                            </option>
                          ))}
                        </Select>
                        <Input
                          type="time"
                          value={minuteToHHMM(c.startMinute)}
                          onChange={(e) => {
                            const next = [...classes]
                            next[i] = { ...c, startMinute: hhmmToMinute(e.target.value) }
                            setClasses(next)
                          }}
                          aria-label="Start time"
                          className="w-32"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Holidays */}
            {holidays.length > 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50/50 p-3">
                <h3 className="mb-2 text-xs font-semibold text-amber-900">
                  Holidays detected (no emails on these dates)
                </h3>
                <div className="space-y-2">
                  {holidays.map((h, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <Checkbox
                        checked={h.keep}
                        onChange={(e) => {
                          const next = [...holidays]
                          next[i] = { ...h, keep: e.target.checked }
                          setHolidays(next)
                        }}
                        aria-label={`Include holiday ${h.name}`}
                      />
                      <Input
                        value={h.name}
                        onChange={(e) => {
                          const next = [...holidays]
                          next[i] = { ...h, name: e.target.value }
                          setHolidays(next)
                        }}
                        className="max-w-xs"
                      />
                      <Input
                        type="date"
                        value={h.startsOn}
                        onChange={(e) => {
                          const next = [...holidays]
                          next[i] = { ...h, startsOn: e.target.value }
                          setHolidays(next)
                        }}
                        className="w-40"
                      />
                      <span className="text-xs text-neutral-500">→</span>
                      <Input
                        type="date"
                        value={h.endsOn}
                        onChange={(e) => {
                          const next = [...holidays]
                          next[i] = { ...h, endsOn: e.target.value }
                          setHolidays(next)
                        }}
                        className="w-40"
                      />
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="flex items-center gap-2 border-t border-neutral-100 pt-3">
              <Button disabled={apply.isPending} onClick={submit}>
                {apply.isPending ? 'Creating…' : 'Create everything'}
              </Button>
              <Button variant="ghost" disabled={apply.isPending} onClick={reset}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
