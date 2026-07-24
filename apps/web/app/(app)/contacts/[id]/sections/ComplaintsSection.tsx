// Complaints on the contact page. Log a complaint against this customer, then
// work each one in the shared ComplaintDetailPanel (thread + action points,
// status/assignee, resolve/archive/delete). Logging posts to Slack
// #complaintcallsummaries and every step mirrors onto the customer's timeline.
// Any staff can log and work a complaint. CLAUDE.md §26.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { ComplaintDetailPanel } from '@/components/complaints/ComplaintDetailPanel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SuggestInput } from '@/components/ui/suggest-input'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'
import { complaintStatusTone } from '@/lib/ui/status-tone'
import { formatRelativeTime } from '@/lib/format/relative-time'

type Severity = 'low' | 'medium' | 'high'

const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
}
const SEVERITY_CLS: Record<Severity, string> = {
  high: 'bg-red-50 text-red-700 ring-1 ring-red-200',
  medium: 'bg-amber-50 text-amber-800 ring-1 ring-amber-200',
  low: 'bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200',
}

export function ComplaintsSection({ contactId }: { contactId: string }) {
  const utils = trpc.useUtils()
  const router = useRouter()
  const listQuery = trpc.complaint.list.useQuery({ contactId, filter: 'all' })
  const complaints = listQuery.data ?? []

  const [adding, setAdding] = useState(false)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState<Severity>('medium')
  const [category, setCategory] = useState('')
  const [busy, setBusy] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)

  const create = trpc.complaint.create.useMutation()
  const categoriesQuery = trpc.complaint.categories.useQuery(undefined, { enabled: adding })

  async function refresh() {
    await Promise.all([
      utils.complaint.list.invalidate({ contactId }),
      utils.complaint.activeCount.invalidate(),
    ])
    router.refresh()
  }

  async function submitNew() {
    if (title.trim().length < 2) {
      toast.error('Give the complaint a short title.')
      return
    }
    setBusy(true)
    try {
      const res = await create.mutateAsync({
        contactId,
        title: title.trim(),
        description: description.trim() || undefined,
        severity,
        category: category.trim() || undefined,
      })
      toast.success(
        res.slack?.status === 'sent'
          ? 'Complaint logged and posted to #complaintcallsummaries'
          : 'Complaint logged',
      )
      setTitle('')
      setDescription('')
      setSeverity('medium')
      setCategory('')
      setAdding(false)
      setOpenId(res.id)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not log the complaint')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-neutral-500">
          {complaints.filter((c) => c.status === 'open' || c.status === 'in_progress').length} active
          · {complaints.length} total
        </p>
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Log complaint
          </Button>
        )}
      </div>

      {adding && (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50/40 p-3">
          <p className="text-[11px] text-emerald-700">
            Logging posts this to Slack #complaintcallsummaries and starts a thread.
          </p>
          <Input
            placeholder="What is the complaint? (short title)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Textarea
            rows={3}
            placeholder="Details — what happened, what the customer is unhappy about…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value as Severity)}>
              <option value="low">Low severity</option>
              <option value="medium">Medium severity</option>
              <option value="high">High severity</option>
            </Select>
            <SuggestInput
              className="w-full max-w-[14rem]"
              aria-label="Complaint category"
              placeholder="Category — pick or type new"
              options={categoriesQuery.data ?? []}
              value={category}
              onChange={setCategory}
            />
          </div>

          <div className="flex gap-2">
            <Button size="sm" onClick={submitNew} disabled={busy || title.trim().length < 2}>
              {busy ? 'Saving…' : 'Log complaint & post to Slack'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {complaints.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-200 px-3 py-4 text-center text-xs text-neutral-500">
          No complaints logged for this customer.
        </p>
      ) : (
        <ul className="space-y-2">
          {complaints.map((c) => (
            <li key={c.id} className="rounded-lg border border-neutral-200">
              <button
                type="button"
                onClick={() => setOpenId(openId === c.id ? null : c.id)}
                className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {c.title}
                  </span>
                  <span className="text-[11px] text-neutral-500">
                    {formatRelativeTime(new Date(c.createdAt), new Date())}
                    {c.category ? ` · ${c.category}` : ''}
                    {c.updateCount > 0 ? ` · ${c.updateCount} update${c.updateCount === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {c.archived ? (
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-500">
                      Archived
                    </span>
                  ) : null}
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase ${SEVERITY_CLS[c.severity as Severity] ?? SEVERITY_CLS.low}`}
                  >
                    {c.severity}
                  </span>
                  <Badge tone={complaintStatusTone(c.status)}>
                    {STATUS_LABEL[c.status] ?? c.status}
                  </Badge>
                </span>
              </button>
              {openId === c.id && (
                <div className="border-t border-neutral-100 bg-neutral-50/50 px-3 py-3">
                  <ComplaintDetailPanel
                    complaintId={c.id}
                    onChanged={refresh}
                    onDeleted={() => {
                      setOpenId(null)
                      void refresh()
                    }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
