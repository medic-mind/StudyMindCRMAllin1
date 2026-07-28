// Retroactive phone-number repair (Manager+): re-derives the correct phone
// number for the contacts on the "Invalid number" board from their ORIGINAL web
// enquiry (which still carries the country code they gave) and fixes the wrong
// +… numbers the dial-code bug produced. Shows a preview of every change first,
// then applies on confirm — nothing is silently overwritten (§3/§34).

'use client'

import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { trpc } from '@/lib/trpc/client'

export function LeadPhoneRepairButton(): JSX.Element {
  const [open, setOpen] = useState(false)
  const utils = trpc.useUtils()
  const preview = trpc.lead.phoneRepair.preview.useQuery(undefined, { enabled: open })
  const apply = trpc.lead.phoneRepair.apply.useMutation({
    onSuccess: (r) => {
      if (r.changed > 0) {
        toast.success(
          `Corrected ${r.changed} number${r.changed === 1 ? '' : 's'} from the original enquiry.`,
        )
      } else {
        toast.success('Nothing to correct — every number is already right or has no enquiry data.')
      }
      void utils.lead.phoneRepair.preview.invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not apply the corrections'),
  })

  const data = preview.data
  const changes = data?.changes ?? []

  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Fix wrong numbers
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Fix wrong phone numbers"
        size="xl"
        dismissable={!apply.isPending}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={apply.isPending}
            >
              Close
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={apply.isPending || preview.isLoading || changes.length === 0}
              onClick={() => apply.mutate()}
            >
              {apply.isPending
                ? 'Correcting…'
                : changes.length > 0
                  ? `Correct ${changes.length} number${changes.length === 1 ? '' : 's'}`
                  : 'Nothing to correct'}
            </Button>
          </div>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="text-neutral-600">
            This re-reads each contact on the <strong>Invalid number</strong> board from their
            original web enquiry — where they gave their country code (e.g.{' '}
            <span className="font-mono">+44</span>, <span className="font-mono">+964</span>) — and
            rebuilds the correct number. Only confident corrections are shown; nothing else is
            touched.
          </p>

          {preview.isLoading ? (
            <p className="text-neutral-500">Scanning the board…</p>
          ) : preview.isError ? (
            <p className="text-red-700">Could not scan: {preview.error?.message}</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
                <span>
                  <strong className="text-neutral-900">{data?.contactCount ?? 0}</strong> contacts on
                  the board
                </span>
                <span>
                  <strong className="text-emerald-700">{changes.length}</strong> can be auto-fixed
                </span>
                <span>
                  <strong className="text-neutral-900">{data?.withoutEnquiryData ?? 0}</strong> have
                  no original enquiry — edit those by hand
                </span>
              </div>

              {changes.length === 0 ? (
                <p className="text-neutral-500">
                  Nothing to auto-correct. Any remaining wrong numbers have no original web enquiry
                  to rebuild from (e.g. added from Todoist or a call) — fix those directly on the
                  card or contact using the number’s <strong>Edit number</strong> option.
                </p>
              ) : (
                <div className="max-h-80 overflow-auto rounded-md border border-neutral-200">
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 bg-neutral-50 text-neutral-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">Contact</th>
                        <th className="px-3 py-2 font-medium">Currently</th>
                        <th className="px-3 py-2 font-medium">Corrected to</th>
                        <th className="px-3 py-2 font-medium">Country</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changes.map((c) => (
                        <tr key={c.contactId} className="border-t border-neutral-100">
                          <td className="px-3 py-2 text-neutral-900">{c.name}</td>
                          <td className="px-3 py-2 font-mono text-red-700 line-through">
                            {c.current ?? '—'}
                          </td>
                          <td className="px-3 py-2 font-mono text-emerald-700">{c.proposed}</td>
                          <td className="px-3 py-2 text-neutral-600">{c.country ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
