'use client'

// Compose a brand-new email from the CRM (ADR 0021 Phase 4). Sends from the
// chosen connected account; the sent message lands in Gmail and the new thread
// appears in /mail. Sales Executive+; the server enforces. CLAUDE.md §14, §26.

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { trpc } from '@/lib/trpc/client'

interface AccountOption {
  id: string
  address: string
  displayName: string | null
}

export function MailCompose({ accounts }: { accounts: AccountOption[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const compose = trpc.mail.compose.useMutation()

  if (accounts.length === 0) return null

  function reset() {
    setTo('')
    setSubject('')
    setBody('')
  }

  async function send() {
    const recipients = to
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (recipients.length === 0 || !subject.trim() || !body.trim() || !accountId) {
      toast.error('Add a recipient, subject and message.')
      return
    }
    try {
      await compose.mutateAsync({
        mailAccountId: accountId,
        to: recipients,
        subject: subject.trim(),
        body: body.trim(),
      })
      toast.success('Email sent')
      reset()
      setOpen(false)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the email')
    }
  }

  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        Compose
      </Button>
    )
  }

  return (
    <div className="space-y-2 rounded-lg border border-neutral-200 bg-white p-3 shadow-sm">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="compose-from" className="text-xs">
            From
          </Label>
          <Select
            id="compose-from"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName ? `${a.displayName} <${a.address}>` : a.address}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="compose-to" className="text-xs">
            To
          </Label>
          <Input
            id="compose-to"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="name@example.com, …"
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="compose-subject" className="text-xs">
          Subject
        </Label>
        <Input
          id="compose-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={6}
        placeholder="Write your message…"
        aria-label="Message body"
        className="w-full resize-y rounded-md border border-neutral-200 px-3 py-2 text-sm focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-200"
      />
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            reset()
            setOpen(false)
          }}
        >
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={compose.isPending} onClick={send}>
          {compose.isPending ? 'Sending…' : 'Send'}
        </Button>
      </div>
    </div>
  )
}
