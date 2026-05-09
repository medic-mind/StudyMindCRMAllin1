// Progress reports per LA contract. CLAUDE.md §43.3, §26.

import { TRPCError } from '@trpc/server'

import { createServerCaller } from '@/lib/trpc/server'

interface PageProps {
  params: Promise<{ contractId: string }>
}

const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  signed: 'Signed',
  rejected: 'Rejected',
}

export default async function LAContractReportsPage({ params }: PageProps) {
  const { contractId } = await params
  const caller = await createServerCaller()

  let reports: Awaited<ReturnType<typeof caller.lacontract.reports.list>> = []
  let forbidden = false
  try {
    reports = await caller.lacontract.reports.list({ contractId })
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="mt-2 text-sm text-neutral-600">
          You need account-lead, finance, or admin role to view reports.
        </p>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Progress reports</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Reports for this contract. Drafts are clearly labelled until the
        account lead signs off; signed reports lock for editing and become
        eligible for PDF export.
      </p>

      {reports.length === 0 ? (
        <div className="mt-8 rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-700">
          No reports yet for this contract. Generate one for the most recent
          period from the contract action menu.
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
          {reports.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 p-3">
              <div className="min-w-0">
                <div className="font-mono text-xs text-neutral-500">
                  {r.periodStart.toISOString().slice(0, 10)} →{' '}
                  {r.periodEnd.toISOString().slice(0, 10)}
                </div>
                <div className="mt-1 text-sm text-neutral-900">Family {r.familyId}</div>
              </div>
              <div className="shrink-0 text-right">
                <span
                  className={
                    r.state === 'draft'
                      ? 'inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800'
                      : r.state === 'signed'
                        ? 'inline-block rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800'
                        : 'inline-block rounded bg-neutral-100 px-2 py-0.5 text-xs font-medium text-neutral-700'
                  }
                >
                  {STATE_LABEL[r.state] ?? r.state}
                </span>
                {r.state === 'draft' ? (
                  <div className="mt-1 text-xs italic text-amber-700">
                    DRAFT — pending review
                  </div>
                ) : null}
                {r.pdfS3Key ? (
                  <div className="mt-1 font-mono text-[10px] text-neutral-500">
                    PDF: {r.pdfS3Key.split('/').pop()}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
