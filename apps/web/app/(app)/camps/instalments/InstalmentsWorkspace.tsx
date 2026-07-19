// Camp instalments client workspace: import the booking CSV, filter to the
// instalment cohort, see deposit vs remaining per booking + headline totals, and
// record a further payment by editing the deposit. Money writes are Manager+.

'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'
import { instalmentStateTone } from '@/lib/ui/status-tone'

type Cohort = 'all' | 'instalments' | 'outstanding'

const STATE_LABEL: Record<string, string> = {
  paid: 'Paid',
  deposit_paid: 'Deposit paid',
  unpaid: 'Unpaid',
}

function poundsToMinor(raw: string): number | null {
  const cleaned = raw.replace(/[£,\s]/gu, '')
  if (cleaned === '') return 0
  const n = Number.parseFloat(cleaned)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

export function InstalmentsWorkspace({ canWrite }: { canWrite: boolean }) {
  const utils = trpc.useUtils()
  const [cohort, setCohort] = useState<Cohort>('instalments')
  const [paymentType, setPaymentType] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')

  const listQuery = trpc.summerCamp.instalments.list.useQuery({
    cohort,
    ...(paymentType ? { paymentType } : {}),
    ...(status ? { status } : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  })
  const importMut = trpc.summerCamp.instalments.importCsv.useMutation()
  const updateMut = trpc.summerCamp.instalments.update.useMutation()
  const removeMut = trpc.summerCamp.instalments.remove.useMutation()

  const data = listQuery.data
  const items = useMemo(() => data?.items ?? [], [data])
  const summary = data?.summary
  const facets = data?.facets

  async function refresh() {
    await utils.summerCamp.instalments.list.invalidate()
  }

  async function onPickFile(file: File | null) {
    if (!file) return
    try {
      const csv = await file.text()
      const res = await importMut.mutateAsync({ csv })
      toast.success(`Imported ${res.total} bookings (${res.created} new, ${res.updated} updated)`)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not import the CSV')
    }
  }

  async function saveDeposit(id: string, raw: string, current: number) {
    const minor = poundsToMinor(raw)
    if (minor === null) {
      toast.error('Enter a valid amount')
      return
    }
    if (minor === current) return
    try {
      await updateMut.mutateAsync({ id, depositPaidMinor: minor })
      toast.success('Deposit updated')
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update')
    }
  }

  async function onRemove(id: string, name: string | null) {
    if (!confirm(`Remove the booking for ${name ?? 'this student'}? (soft delete)`)) return
    try {
      await removeMut.mutateAsync({ id })
      toast.success('Removed')
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove')
    }
  }

  return (
    <div className="space-y-5">
      {/* Import + summary */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {(['instalments', 'outstanding', 'all'] as Cohort[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCohort(c)}
              className={
                c === cohort
                  ? 'rounded-full bg-primary-600 px-3 py-1 text-xs font-medium text-white'
                  : 'rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:border-primary-300'
              }
            >
              {c === 'instalments'
                ? 'On instalments'
                : c === 'outstanding'
                  ? 'Balance owing'
                  : 'All bookings'}
            </button>
          ))}
        </div>
        {canWrite ? (
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-primary-300 bg-white px-3 py-1.5 text-sm font-medium text-primary-700 transition-colors hover:bg-primary-50">
            <input
              type="file"
              accept=".csv,text/csv"
              className="sr-only"
              onChange={(e) => {
                void onPickFile(e.target.files?.[0] ?? null)
                e.currentTarget.value = ''
              }}
            />
            {importMut.isPending ? 'Importing…' : 'Import booking CSV'}
          </label>
        ) : null}
      </div>

      {summary ? (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <SummaryTile
            label="Bookings"
            value={`${summary.count}`}
            hint={`${summary.onInstalments} on instalments`}
          />
          <SummaryTile label="Total due" value={formatMoneyMinor(summary.totalDueMinor)} />
          <SummaryTile
            label="Received"
            value={formatMoneyMinor(summary.totalDepositMinor)}
            tone="success"
          />
          <SummaryTile
            label="Outstanding"
            value={formatMoneyMinor(summary.totalOutstandingMinor)}
            tone={summary.totalOutstandingMinor > 0 ? 'warn' : 'neutral'}
          />
        </div>
      ) : null}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-xs"
          placeholder="Search student / guardian / subject…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          value={paymentType}
          onChange={(e) => setPaymentType(e.target.value)}
          className="w-44"
          aria-label="Payment type"
        >
          <option value="">All payment types</option>
          {(facets?.paymentTypes ?? []).map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </Select>
        <Select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-40"
          aria-label="Status"
        >
          <option value="">All statuses</option>
          {(facets?.statuses ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>

      {/* Table */}
      {listQuery.isLoading ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-600">
          No bookings here yet.{' '}
          {canWrite
            ? 'Import the booking CSV to get started.'
            : 'Ask a manager to import the booking CSV.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-200 bg-neutral-50 text-left text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-2">Student</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Payment type</th>
                <th className="px-3 py-2 text-right">Total due</th>
                <th className="px-3 py-2 text-right">Deposit paid</th>
                <th className="px-3 py-2 text-right">Remaining</th>
                <th className="px-3 py-2">Status</th>
                {canWrite ? <th className="px-3 py-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((b) => (
                <tr key={b.id} className="border-b border-neutral-100 last:border-0">
                  <td className="px-3 py-2">
                    <div className="font-medium text-neutral-900">{b.studentName ?? '—'}</div>
                    <div className="text-xs text-neutral-500">
                      {b.studentEmail ?? b.guardianName ?? ''}
                      {b.weeks ? ` · ${b.weeks}` : ''}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-neutral-700">{b.subject ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-700">
                      {b.paymentType ?? '—'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-700">
                    {formatMoneyMinor(b.totalDueMinor)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canWrite ? (
                      <input
                        type="text"
                        defaultValue={(b.depositPaidMinor / 100).toString()}
                        onBlur={(e) => void saveDeposit(b.id, e.target.value, b.depositPaidMinor)}
                        aria-label={`Deposit paid for ${b.studentName ?? 'booking'}`}
                        className="w-24 rounded border border-neutral-200 px-2 py-1 text-right font-mono text-xs tabular-nums focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-400"
                      />
                    ) : (
                      <span className="font-mono tabular-nums text-neutral-700">
                        {formatMoneyMinor(b.depositPaidMinor)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums text-neutral-900">
                    {formatMoneyMinor(b.remainingMinor)}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={instalmentStateTone(b.state)} className="uppercase">
                      {STATE_LABEL[b.state] ?? b.state}
                    </Badge>
                  </td>
                  {canWrite ? (
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void onRemove(b.id, b.studentName)}
                        className="text-xs text-neutral-400 hover:text-red-600"
                        aria-label="Remove booking"
                      >
                        Remove
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canWrite ? (
        <p className="text-xs text-neutral-500">
          Re-importing the latest CSV updates existing bookings (matched on student + subject +
          weeks) and adds new ones — it never duplicates. Edit a deposit to record a further
          instalment; the remaining balance recalculates automatically.
        </p>
      ) : null}
    </div>
  )
}

function SummaryTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string
  value: string
  hint?: string
  tone?: 'neutral' | 'success' | 'warn'
}) {
  const bar =
    tone === 'success' ? 'bg-emerald-500' : tone === 'warn' ? 'bg-amber-500' : 'bg-neutral-300'
  return (
    <Card className="relative overflow-hidden px-3 py-2.5 pl-4">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${bar}`} />
      <div className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className="font-mono text-xl font-semibold tabular-nums text-neutral-900">{value}</div>
      <div className="text-xs text-neutral-500">{hint ?? ' '}</div>
    </Card>
  )
}
