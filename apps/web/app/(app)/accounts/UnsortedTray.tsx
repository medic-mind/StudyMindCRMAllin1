// Unsorted tray for accounts imported from the B2B Invoices Platform that the
// auto-classifier couldn't confidently file as a School or a B2B Partner.
// One-click "Class as School / Class as B2B Partner" buttons. Manager+.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { trpc } from '@/lib/trpc/client'

export function UnsortedTray({ initialCount }: { initialCount: number }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const list = trpc.businessAccount.unsortedList.useQuery({ limit: 100 }, { enabled: open })
  const classify = trpc.businessAccount.classify.useMutation()
  const [busyId, setBusyId] = useState<string | null>(null)

  const rows = list.data ?? []
  const count = open ? rows.length : initialCount

  async function handleClassify(id: string, kind: 'school' | 'partnership') {
    setBusyId(id)
    try {
      await classify.mutateAsync({ id, kind })
      toast.success(kind === 'school' ? 'Filed as School' : 'Filed as B2B Partner')
      await list.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not classify')
    } finally {
      setBusyId(null)
    }
  }

  if (count === 0) return null

  return (
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4 shadow-card">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-3 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-amber-500 px-2 text-xs font-bold text-white">
            {count}
          </span>
          <span className="text-sm font-semibold text-amber-900">
            {count === 1 ? '1 account needs' : `${count} accounts need`} classifying
          </span>
          <span className="text-xs text-amber-700">
            Imported from the invoicing platform — file each as a School or B2B Partner.
          </span>
        </div>
        <span className="text-xs font-medium text-amber-800">{open ? 'Hide' : 'Review'}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-2">
          {list.isLoading ? (
            <p className="text-sm text-amber-800">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-amber-800">All caught up — nothing to classify.</p>
          ) : (
            <ul className="space-y-2">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-2 rounded-lg border border-amber-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-neutral-900">{r.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-neutral-500">
                      {r.contactEmail && <span>{r.contactEmail}</span>}
                      {(r.city || r.country) && (
                        <span>{[r.city, r.country].filter(Boolean).join(', ')}</span>
                      )}
                      {r.classificationReason && (
                        <span className="italic">{r.classificationReason}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busyId === r.id}
                      onClick={() => handleClassify(r.id, 'school')}
                    >
                      Class as School
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={busyId === r.id}
                      onClick={() => handleClassify(r.id, 'partnership')}
                    >
                      Class as B2B Partner
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
