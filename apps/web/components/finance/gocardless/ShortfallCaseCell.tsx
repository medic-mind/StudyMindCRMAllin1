'use client'

// Per-plan recovery-case control on the Issues tab (cancelled/underpaid +
// behind-schedule plans). The single action is OPEN THE CASE — the full
// CaseDetailModal mini-CRM: every message ever sent, the recovery step, the
// automated-reminder on/off switch, and an inline email/SMS composer that works
// even for a plan with no CRM contact. A compact chip summarises the automation
// state at a glance. This replaces the old status/owner dropdowns + the
// contact-required "Send message" dialog that dead-ended on unlinked plans
// (most cancelled plans predate the CRM). Reads open to all staff; creating a
// case is finance-gated (server-enforced). CLAUDE.md §3.

import { useState } from 'react'
import { toast } from 'sonner'

import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatMoneyMinor } from '@/lib/format/money'
import { trpc } from '@/lib/trpc/client'

import { CaseDetailModal } from './CaseDetailModal'

const STATUS_LABEL: Record<string, string> = {
  new: 'New',
  chasing: 'Chasing',
  escalated: 'Escalated',
  recovered: 'Up to date',
  written_off: 'Written off',
}

const STATUS_TONE: Record<string, BadgeTone> = {
  new: 'neutral',
  chasing: 'info',
  escalated: 'danger',
  recovered: 'success',
  written_off: 'neutral',
}

export interface ShortfallCaseLinks {
  gcSubscriptionId: string
  gcCustomerId: string | null
  contactId: string | null
  familyId: string | null
  openingShortfallMinor: number
}

export interface ShortfallCaseData {
  id: string
  status: string
  ownerName: string | null
  recoveredMinor?: number
  autoChase: boolean
  sendEmails: boolean
  sendTexts: boolean
  hasSetupLink: boolean
  escalationStep: number
  messageCount: number
}

/** The one-line automation summary shown on the row (read-at-a-glance). */
function automationSummary(c: ShortfallCaseData): { label: string; tone: BadgeTone } {
  if (c.status === 'recovered') return { label: 'Recovered', tone: 'success' }
  if (c.status === 'written_off') return { label: 'Written off', tone: 'neutral' }
  if (!c.autoChase || (!c.sendEmails && !c.sendTexts)) return { label: 'Auto reminders off', tone: 'neutral' }
  if (!c.hasSetupLink) return { label: 'Auto on · needs link', tone: 'warn' }
  return { label: `Auto on · step ${c.escalationStep + 1}`, tone: 'info' }
}

export function ShortfallCaseCell({
  links,
  caseData,
  canWrite,
}: {
  links: ShortfallCaseLinks
  caseData: ShortfallCaseData | undefined
  canWrite: boolean
}) {
  const utils = trpc.useUtils()
  const [openCaseId, setOpenCaseId] = useState<string | null>(null)
  const openCase = trpc.finance.directDebit.cases.openCaseForSubscription.useMutation({
    onSuccess: (res) => setOpenCaseId(res.id),
    onError: (e) => toast.error(e.message ?? 'Could not open the recovery case'),
  })

  const summary = caseData ? automationSummary(caseData) : null

  function open() {
    if (caseData?.id) {
      setOpenCaseId(caseData.id)
      return
    }
    openCase.mutate({
      gcSubscriptionId: links.gcSubscriptionId,
      outstandingMinor: links.openingShortfallMinor,
      links: {
        gcCustomerId: links.gcCustomerId,
        contactId: links.contactId,
        familyId: links.familyId,
      },
    })
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {caseData ? (
        <>
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Badge tone={STATUS_TONE[caseData.status] ?? 'neutral'}>
              {STATUS_LABEL[caseData.status] ?? caseData.status}
            </Badge>
            {summary ? <Badge tone={summary.tone}>{summary.label}</Badge> : null}
          </div>
          {caseData.status === 'recovered' && caseData.recoveredMinor ? (
            <span className="font-mono text-[11px] tabular-nums text-emerald-700">
              {formatMoneyMinor(caseData.recoveredMinor)} recovered
            </span>
          ) : caseData.messageCount > 0 ? (
            <span className="text-[11px] text-neutral-500">
              {caseData.messageCount} message{caseData.messageCount === 1 ? '' : 's'} sent
            </span>
          ) : null}
        </>
      ) : (
        <span className="text-[11px] text-neutral-400">No recovery case yet</span>
      )}

      {caseData || canWrite ? (
        <Button type="button" size="sm" variant="secondary" disabled={openCase.isPending} onClick={open}>
          {openCase.isPending ? 'Opening…' : caseData ? 'Open case' : 'Start recovery'}
        </Button>
      ) : null}

      {openCaseId ? (
        <CaseDetailModal
          caseId={openCaseId}
          canWrite={canWrite}
          onClose={() => {
            setOpenCaseId(null)
            void utils.finance.directDebit.cases.forSubscriptions.invalidate()
          }}
        />
      ) : null}
    </div>
  )
}
