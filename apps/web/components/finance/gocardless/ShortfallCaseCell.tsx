'use client'

// Per-shortfall recovery-case controls on the Issues tab (ADR 0038, seventh
// amendment): set the workflow status and assign an owner. The case is created
// lazily on first action. Read/write CRM state only — outbound recovery comms
// are human-confirmed elsewhere (CLAUDE.md §3).

import { toast } from 'sonner'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { RecordRecoveryDialog } from './RecordRecoveryDialog'

const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  chasing: 'Chasing',
  escalated: 'Escalated',
  recovered: 'Recovered',
  written_off: 'Written off',
}

const STATUS_TONE: Record<string, BadgeTone> = {
  new: 'neutral',
  chasing: 'info',
  escalated: 'danger',
  recovered: 'success',
  written_off: 'neutral',
}

const STATUS_OPTIONS = ['new', 'chasing', 'escalated', 'recovered', 'written_off'] as const

export interface ShortfallCaseLinks {
  gcSubscriptionId: string
  gcCustomerId: string | null
  contactId: string | null
  familyId: string | null
  openingShortfallMinor: number
}

interface CaseData {
  status: string
  ownerUserId: string | null
  ownerName: string | null
  recoveredMinor?: number
}

export function ShortfallCaseCell({
  links,
  caseData,
  assignableUsers,
}: {
  links: ShortfallCaseLinks
  caseData: CaseData | undefined
  assignableUsers: Array<{ id: string; name: string }>
}) {
  const utils = trpc.useUtils()
  const invalidate = () => utils.finance.directDebit.cases.forSubscriptions.invalidate()

  const setStatus = trpc.finance.directDebit.cases.setStatus.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })
  const assign = trpc.finance.directDebit.cases.assign.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  })

  const linkPayload = {
    gcCustomerId: links.gcCustomerId,
    contactId: links.contactId,
    familyId: links.familyId,
    openingShortfallMinor: links.openingShortfallMinor,
  }

  const status = caseData?.status ?? 'new'
  const busy = setStatus.isPending || assign.isPending

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>
        {status === 'recovered' && caseData?.recoveredMinor ? (
          <span className="font-mono text-[11px] tabular-nums text-emerald-700">
            {formatMoneyMinor(caseData.recoveredMinor)}
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-1">
        <select
          aria-label="Case status"
          className="h-6 rounded border border-neutral-200 bg-white px-1 text-[11px] text-neutral-700 disabled:opacity-50"
          value={status}
          disabled={busy}
          onChange={(e) =>
            setStatus.mutate({
              gcSubscriptionId: links.gcSubscriptionId,
              status: e.target.value,
              links: linkPayload,
            })
          }
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Case owner"
          className="h-6 max-w-[7rem] rounded border border-neutral-200 bg-white px-1 text-[11px] text-neutral-700 disabled:opacity-50"
          value={caseData?.ownerUserId ?? ''}
          disabled={busy}
          onChange={(e) =>
            assign.mutate({
              gcSubscriptionId: links.gcSubscriptionId,
              ownerUserId: e.target.value || null,
              links: linkPayload,
            })
          }
        >
          <option value="">Unassigned</option>
          {assignableUsers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>
      {status !== 'recovered' ? (
        <RecordRecoveryDialog links={links} defaultAmountMinor={links.openingShortfallMinor} />
      ) : null}
    </div>
  )
}
