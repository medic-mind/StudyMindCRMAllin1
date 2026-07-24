// GDPR right-to-erasure control (CEO / Senior Manager). Opens a confirm modal
// offering either a 30-day scheduled erasure (reversible until the grace window
// passes) or an immediate, irreversible erasure. Both require retyping the
// contact's name. The server re-checks the role and the confirmation.
// CLAUDE.md §21, §34 (irreversible action — deliberate friction).

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string
  displayName: string
}

export function EraseContactButton({ contactId, displayName }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [reason, setReason] = useState('')

  const erase = trpc.contact.erase.useMutation()
  const schedule = trpc.contact.scheduleErasure.useMutation()

  const expected = (displayName || '').trim()
  const confirmMatches =
    expected.length > 0
      ? confirmName.trim().toLowerCase() === expected.toLowerCase()
      : confirmName.trim().toLowerCase() === 'erase'
  const busy = erase.isPending || schedule.isPending

  function close() {
    setOpen(false)
    setConfirmName('')
    setReason('')
  }

  async function onEraseNow() {
    try {
      await erase.mutateAsync({ id: contactId, confirmName, reason: reason || undefined })
      toast.success('Contact permanently erased.')
      close()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Erasure failed.')
    }
  }

  async function onSchedule() {
    try {
      const r = await schedule.mutateAsync({ id: contactId, reason: reason || undefined })
      toast.success(
        `Erasure scheduled for ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(
          new Date(r.erasureScheduledAt),
        )}. Reversible until then.`,
      )
      close()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not schedule erasure.')
    }
  }

  return (
    <>
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
        Erase (GDPR)
      </Button>
      <Modal
        open={open}
        onClose={busy ? () => {} : close}
        dismissable={!busy}
        title="Erase this contact (GDPR)"
        size="md"
      >
        <div className="space-y-4 text-sm">
          <p className="text-neutral-700">
            This permanently destroys <strong>{expected || 'this contact'}</strong>&rsquo;s
            personal data — name, contact details, notes, message content and any encrypted
            fields are irreversibly shredded and anonymised. The action is recorded in the audit
            log. This <strong>cannot be undone</strong>.
          </p>
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
            You can either schedule erasure with a 30-day grace window (reversible until then) or
            erase immediately.
          </div>
          <label className="block">
            <span className="text-xs font-medium text-neutral-600">
              Reason (optional — recorded on the audit trail)
            </span>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Data-subject erasure request"
              className="mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-neutral-600">
              Type <strong>{expected || 'ERASE'}</strong> to confirm
            </span>
            <input
              type="text"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-md border border-neutral-200 px-3 py-2 text-sm"
            />
          </label>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={onSchedule}
              disabled={busy}
            >
              {schedule.isPending ? 'Scheduling…' : 'Schedule (30-day grace)'}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onEraseNow}
              disabled={busy || !confirmMatches}
            >
              {erase.isPending ? 'Erasing…' : 'Erase now'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
