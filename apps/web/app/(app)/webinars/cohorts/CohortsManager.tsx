'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

import type { CohortRow } from '../types'

const STATUS_TONE: Record<string, 'success' | 'info' | 'neutral'> = {
  active: 'success',
  planning: 'info',
  archived: 'neutral',
}

export function CohortsManager({
  initialCohorts,
  canManage,
}: {
  initialCohorts: CohortRow[]
  canManage: boolean
}) {
  const utils = trpc.useUtils()
  const list = trpc.webinar.cohort.list.useQuery(undefined, { initialData: initialCohorts })
  const [expanded, setExpanded] = useState<string | null>(null)

  const create = trpc.webinar.cohort.create.useMutation({
    onSuccess: () => {
      toast.success('Cohort created')
      void utils.webinar.cohort.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const setStatus = trpc.webinar.cohort.setStatus.useMutation({
    onSuccess: () => void utils.webinar.cohort.list.invalidate(),
    onError: (e) => toast.error(e.message),
  })

  const [name, setName] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')

  const cohorts = list.data ?? []

  return (
    <div className="space-y-6">
      {canManage ? (
        <Card>
          <CardBody>
            <h2 className="mb-3 text-sm font-semibold text-neutral-900">New cohort</h2>
            <form
              className="grid gap-3 md:grid-cols-4"
              onSubmit={(e) => {
                e.preventDefault()
                create.mutate({ name, startsOn, endsOn })
              }}
            >
              <Field label="Name" htmlFor="c-name">
                <Input
                  id="c-name"
                  placeholder="2026/2027"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>
              <Field label="Starts on" htmlFor="c-start">
                <Input
                  id="c-start"
                  type="date"
                  value={startsOn}
                  onChange={(e) => setStartsOn(e.target.value)}
                  required
                />
              </Field>
              <Field label="Ends on" htmlFor="c-end">
                <Input
                  id="c-end"
                  type="date"
                  value={endsOn}
                  onChange={(e) => setEndsOn(e.target.value)}
                  required
                />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? 'Creating…' : 'Create cohort'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {cohorts.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">
              No cohorts yet — create your first academic year above (e.g. 2026/2027).
            </p>
          </CardBody>
        </Card>
      ) : (
        <div className="space-y-3">
          {cohorts.map((c) => (
            <Card key={c.id}>
              <CardBody>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-base font-semibold text-neutral-900">{c.name}</span>
                      <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                    </div>
                    <div className="mt-0.5 text-xs text-neutral-500">
                      {c.startsOn} → {c.endsOn} · {c.timezone} · {c.classCount} classes ·{' '}
                      {c.holidayCount} holidays
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {canManage ? (
                      <Select
                        value={c.status}
                        onChange={(e) =>
                          setStatus.mutate({
                            id: c.id,
                            status: e.target.value as CohortRow['status'],
                          })
                        }
                      >
                        <option value="planning">Planning</option>
                        <option value="active">Active</option>
                        <option value="archived">Archived</option>
                      </Select>
                    ) : null}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setExpanded(expanded === c.id ? null : c.id)}
                    >
                      {expanded === c.id ? 'Hide holidays' : 'Holidays'}
                    </Button>
                  </div>
                </div>
                {expanded === c.id ? <Holidays cohortId={c.id} canManage={canManage} /> : null}
              </CardBody>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function Holidays({ cohortId, canManage }: { cohortId: string; canManage: boolean }) {
  const utils = trpc.useUtils()
  const cohort = trpc.webinar.cohort.get.useQuery({ id: cohortId })
  const add = trpc.webinar.cohort.addHoliday.useMutation({
    onSuccess: () => {
      toast.success('Holiday added')
      void utils.webinar.cohort.get.invalidate({ id: cohortId })
      void utils.webinar.cohort.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = trpc.webinar.cohort.removeHoliday.useMutation({
    onSuccess: () => {
      void utils.webinar.cohort.get.invalidate({ id: cohortId })
      void utils.webinar.cohort.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const [name, setName] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')

  const holidays = cohort.data?.holidays ?? []

  return (
    <div className="mt-4 border-t border-neutral-100 pt-4">
      {holidays.length === 0 ? (
        <p className="text-xs text-neutral-500">No holidays set for this cohort.</p>
      ) : (
        <ul className="space-y-1">
          {holidays.map((h) => (
            <li
              key={h.id}
              className="flex items-center justify-between rounded bg-neutral-50 px-3 py-1.5 text-sm"
            >
              <span>
                <span className="font-medium text-neutral-800">{h.name}</span>{' '}
                <span className="text-neutral-500">
                  {h.startsOn} → {h.endsOn}
                </span>
              </span>
              {canManage ? (
                <Button variant="ghost" size="xs" onClick={() => remove.mutate({ id: h.id })}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form
          className="mt-3 grid gap-2 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate({ cohortId, name, startsOn, endsOn })
            setName('')
            setStartsOn('')
            setEndsOn('')
          }}
        >
          <Input
            placeholder="Christmas break"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} required />
          <Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} required />
          <Button type="submit" variant="secondary" size="sm" disabled={add.isPending}>
            Add holiday
          </Button>
        </form>
      ) : null}
    </div>
  )
}
