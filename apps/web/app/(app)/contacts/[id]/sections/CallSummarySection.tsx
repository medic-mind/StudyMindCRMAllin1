// Write a call summary against a contact and (optionally) fan it out to
// Slack, Trengo, and email in one click. Mirrors the existing card.callSummary
// flow on boards but works directly against the contact. CLAUDE.md §10, §11.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

type Outcome = 'answered' | 'voicemail' | 'no_answer'

interface DbTemplate {
  id: string
  name: string
  body: string
  hasPdf: boolean
  pdfFileName: string | null
}

interface Props {
  contactId: string
  contactDisplayName: string
}

export function CallSummarySection({ contactId, contactDisplayName }: Props) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [outcome, setOutcome] = useState<Outcome>('answered')
  const [slack, setSlack] = useState(false)
  const [trengo, setTrengo] = useState(false)
  const [email, setEmail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)

  const add = trpc.contact.callSummary.add.useMutation()
  const send = trpc.contact.callSummary.send.useMutation()
  const utils = trpc.useUtils()
  const templatesQuery = trpc.callSummaryTemplate.pickList.useQuery()
  const templates: DbTemplate[] = templatesQuery.data ?? []
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? null
  const [drafting, setDrafting] = useState(false)

  function pickTemplate(t: DbTemplate) {
    setBody(t.body)
    setActiveTemplateId(t.id)
  }

  async function draftFromCall() {
    setDrafting(true)
    try {
      const result = await utils.contact.callSummary.draftFromCall.fetch({ contactId })
      if (result.status === 'no_call') {
        toast('No calls recorded for this contact yet.')
        return
      }
      if (result.status === 'no_transcript') {
        toast(
          'Latest call has no transcript yet. Enable Aircall AI Assist or wait for Whisper to finish.',
        )
        return
      }
      setBody(result.text)
      if (result.outcomeHint) setOutcome(result.outcomeHint as Outcome)
      toast.success('AI draft ready — edit before saving.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not draft from call')
    } finally {
      setDrafting(false)
    }
  }

  async function save(alsoSend: boolean) {
    if (!body.trim()) {
      toast.error('Add some text first.')
      return
    }
    setBusy(true)
    try {
      const created = await add.mutateAsync({ contactId, body, outcome })
      toast.success('Call summary saved')

      if (alsoSend && (slack || trengo || email)) {
        const results = await send.mutateAsync({
          summaryInteractionId: created.id,
          channels: { slack, trengo, email },
        })
        const parts: string[] = []
        for (const k of ['slack', 'trengo', 'email'] as const) {
          const r = results[k]
          if (!r) continue
          if (r.status === 'sent') parts.push(`${k} ✓`)
          else if (r.status === 'skipped')
            parts.push(`${k} skipped${r.detail ? ` (${r.detail})` : ''}`)
          else parts.push(`${k} failed${r.detail ? ` (${r.detail})` : ''}`)
        }
        if (parts.length) toast(parts.join(' · '))
      }
      setBody('')
      setSlack(false)
      setTrengo(false)
      setEmail(false)
      setActiveTemplateId(null)
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          Quick start
        </span>
        <button
          type="button"
          onClick={draftFromCall}
          disabled={drafting}
          className="inline-flex items-center gap-1.5 rounded-full border border-primary-300 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-800 transition-colors hover:bg-primary-100 disabled:opacity-50"
        >
          <span aria-hidden="true">✨</span>
          {drafting ? 'Drafting…' : 'AI draft from latest call'}
        </button>
        {templates.map((t) => {
          const active = t.id === activeTemplateId
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => pickTemplate(t)}
              className={
                active
                  ? 'inline-flex items-center gap-1 rounded-full border border-primary-300 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-800'
                  : 'inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700'
              }
            >
              {t.name}
              {t.hasPdf ? (
                <span
                  aria-hidden
                  className="rounded bg-primary-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary-800"
                >
                  PDF
                </span>
              ) : null}
            </button>
          )
        })}
        {templatesQuery.data && templates.length === 0 ? (
          <span className="text-xs text-neutral-500">
            No templates yet — admins can add some at Settings → Call summary templates.
          </span>
        ) : null}
      </div>

      {activeTemplate?.hasPdf ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary-200 bg-primary-50/50 px-3 py-2 text-xs">
          <span className="font-medium text-primary-900">
            Script for {activeTemplate.name}:
          </span>
          <a
            href={`/api/call-summary-templates/${activeTemplate.id}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary-800 hover:underline"
          >
            Open PDF{activeTemplate.pdfFileName ? ` (${activeTemplate.pdfFileName})` : ''}
          </a>
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_10rem]">
        <Textarea
          rows={5}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={`Summarise the call with ${contactDisplayName}…`}
        />
        <div className="space-y-1.5">
          <label className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500">
            Outcome
          </label>
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome)}>
            <option value="answered">Answered</option>
            <option value="voicemail">Voicemail</option>
            <option value="no_answer">No answer</option>
          </Select>
        </div>
      </div>

      <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 p-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          Send after saving
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              checked={slack}
              onChange={(e) => setSlack(e.target.checked)}
            />
            Slack (#crm-alerts)
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              checked={trengo}
              onChange={(e) => setTrengo(e.target.checked)}
            />
            Trengo (latest conversation)
          </label>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
              checked={email}
              onChange={(e) => setEmail(e.target.checked)}
            />
            Email (via Gmail)
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={() => save(false)} disabled={busy || !body.trim()}>
          {busy ? 'Saving…' : 'Save summary'}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => save(true)}
          disabled={busy || !body.trim() || (!slack && !trengo && !email)}
        >
          Save &amp; send
        </Button>
      </div>

      <p className="text-[11px] text-neutral-500">
        Each channel is best-effort and independent — one failing channel never aborts the others. The summary and the per-channel result both land on this contact&apos;s timeline.
      </p>
    </div>
  )
}
