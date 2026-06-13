'use client'

import { useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardBody } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

import { TimetableImport } from './TimetableImport'

import type { CohortRow } from '../types'

const STATUS_TONE: Record<string, 'success' | 'info' | 'neutral'> = {
  active: 'success',
  planning: 'info',
  archived: 'neutral',
}

/** Suggest Sep 1 – Jul 31 from a "2026/2027" style year. */
function suggestDates(name: string): { startsOn: string; endsOn: string } | null {
  const m = /(\d{4})\s*\/\s*(\d{2,4})/.exec(name)
  if (!m) return null
  const start = Number(m[1])
  const endRaw = m[2]!.length === 2 ? Number(`${String(start).slice(0, 2)}${m[2]}`) : Number(m[2])
  return { startsOn: `${start}-09-01`, endsOn: `${endRaw}-07-31` }
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
  const create = trpc.webinar.cohort.create.useMutation({
    onSuccess: () => {
      toast.success('Cohort created')
      setName('')
      void utils.webinar.cohort.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })

  const [name, setName] = useState('')
  const [startsOn, setStartsOn] = useState('')
  const [endsOn, setEndsOn] = useState('')

  const cohorts = list.data ?? []

  return (
    <div className="space-y-6">
      {canManage ? <TimetableImport /> : null}

      {canManage ? (
        <Card>
          <CardBody>
            <h2 className="mb-1 text-sm font-semibold text-neutral-900">New academic year</h2>
            <p className="mb-3 text-xs text-neutral-500">
              Name it like <code className="rounded bg-neutral-100 px-1">2026/2027</code> and the
              term dates are filled in for you (you can adjust them after).
            </p>
            <form
              className="grid gap-3 md:grid-cols-4"
              onSubmit={(e) => {
                e.preventDefault()
                const dates = suggestDates(name)
                create.mutate({
                  name,
                  status: 'active',
                  startsOn: startsOn || dates?.startsOn || '',
                  endsOn: endsOn || dates?.endsOn || '',
                })
              }}
            >
              <Field label="Year" htmlFor="c-name">
                <Input
                  id="c-name"
                  placeholder="2026/2027"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </Field>
              <Field label="Starts (optional)" htmlFor="c-start">
                <Input id="c-start" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
              </Field>
              <Field label="Ends (optional)" htmlFor="c-end">
                <Input id="c-end" type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
              </Field>
              <div className="flex items-end">
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending ? 'Creating…' : 'Create'}
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      ) : null}

      {cohorts.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-sm text-neutral-500">No cohorts yet — create one above.</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-3">
          {cohorts.map((c) => (
            <Link key={c.id} href={`/webinars/cohorts/${c.id}`} className="block">
              <Card className="transition-shadow hover:shadow-md">
                <CardBody>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-base font-semibold text-neutral-900">{c.name}</span>
                        <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>{c.status}</Badge>
                      </div>
                      <div className="mt-0.5 text-xs text-neutral-500">
                        {c.startsOn} → {c.endsOn} · {c.classCount} classes · {c.holidayCount} holidays
                      </div>
                    </div>
                    <span className="text-sm text-primary-700">Open →</span>
                  </div>
                </CardBody>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
