'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { trpc } from '@/lib/trpc/client'

type SourceType = 'call' | 'message' | 'email' | 'third_party' | 'note'
type Urgency = 'routine' | 'urgent' | 'immediate'

export function RaiseConcernForm({ contactId }: { contactId: string }) {
  const router = useRouter()
  const [sourceType, setSourceType] = useState<SourceType>('call')
  const [sourceId, setSourceId] = useState('')
  const [urgency, setUrgency] = useState<Urgency>('routine')
  const [body, setBody] = useState('')
  const [isInPlacement, setIsInPlacement] = useState(false)

  const raise = trpc.safeguarding.raise.useMutation({
    onSuccess: () => {
      toast.success('Concern raised — on-duty DSL notified.')
      router.push(`/contacts/${contactId}`)
      router.refresh()
    },
    onError: (err) => toast.error(err.message ?? 'Could not raise concern'),
  })

  return (
    <form
      className="space-y-4 rounded-md border border-neutral-200 bg-white p-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!body.trim()) {
          toast.error('Body is required')
          return
        }
        raise.mutate({
          contactId,
          sourceType,
          sourceId: sourceId.trim() || null,
          urgency,
          body: body.trim(),
          isInPlacement,
        })
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="src-type">Nature / source</Label>
        <select
          id="src-type"
          className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
          value={sourceType}
          onChange={(e) => setSourceType(e.target.value as SourceType)}
        >
          <option value="call">Call</option>
          <option value="message">Message</option>
          <option value="email">Email</option>
          <option value="third_party">Third party</option>
          <option value="note">Note</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="src-id">Source reference (optional)</Label>
        <Input
          id="src-id"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
          placeholder="Aircall call id, Trengo ticket id, etc."
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="urgency">Urgency</Label>
        <select
          id="urgency"
          className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
          value={urgency}
          onChange={(e) => setUrgency(e.target.value as Urgency)}
        >
          <option value="routine">Routine (4h)</option>
          <option value="urgent">Urgent (1h)</option>
          <option value="immediate">Immediate (15m, pages DSL)</option>
        </select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="body">What happened?</Label>
        <Textarea
          id="body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={6}
          placeholder="Specific facts only. Avoid speculation."
          maxLength={8000}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={isInPlacement}
          onChange={(e) => setIsInPlacement(e.target.checked)}
        />
        Child is currently in an active placement
      </label>
      <div className="flex justify-end">
        <Button type="submit" disabled={raise.isPending}>
          {raise.isPending ? 'Raising…' : 'Raise concern'}
        </Button>
      </div>
    </form>
  )
}
