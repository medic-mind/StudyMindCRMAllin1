// AI knowledge editor (ADR 0040). Client leaf: instruction → AI-proposed
// patches (with current values) → human review with per-patch selection →
// apply. The server re-validates everything; this UI is the confirmation
// step (§3 — AI suggests, humans confirm).

'use client'

import Link from 'next/link'
import { useState } from 'react'

import type { KnowledgeValue } from '@studymind/core/knowledge'

import { Button } from '@/components/ui/button'
import { useConfirm } from '@/components/ui/confirm'
import { SparklesIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

interface ProposedPatch {
  op: 'replace' | 'add' | 'remove'
  path: string
  value?: unknown
  current: unknown
}

interface Proposal {
  summary: string
  patches: ProposedPatch[]
  validationError: string | null
}

const EXAMPLES = [
  'Change the Platinum tier hours to 105.',
  'Add a glossary entry: TARA — Test of Academic Reasoning for Admissions.',
  'Update the 2-week shadowing price to £3,099.',
  'Add a new FAQ: "Do you offer sibling discounts?" — answer that we offer complimentary hours instead, confirm current offers with Becca.',
]

function preview(value: unknown): string {
  if (value === undefined) return '—'
  const text = JSON.stringify(value, null, 1) ?? 'null'
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}

const OP_STYLES: Record<ProposedPatch['op'], string> = {
  add: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  replace: 'bg-amber-50 text-amber-700 border-amber-200',
  remove: 'bg-rose-50 text-rose-700 border-rose-200',
}

export function KnowledgeEditor() {
  const confirm = useConfirm()
  const utils = trpc.useUtils()
  const [instruction, setInstruction] = useState('')
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const status = trpc.knowledge.status.useQuery()

  const propose = trpc.knowledge.edit.propose.useMutation({
    onSuccess: (data) => {
      setProposal(data)
      setSelected(new Set(data.patches.map((_, idx) => idx)))
      setNotice(null)
      setError(data.validationError)
    },
    onError: (err) => setError(err.message),
  })

  const apply = trpc.knowledge.edit.commit.useMutation({
    onSuccess: (data) => {
      setProposal(null)
      setInstruction('')
      setNotice(`Applied ${data.applied} change${data.applied === 1 ? '' : 's'}.`)
      setError(null)
      void utils.knowledge.status.invalidate()
      void utils.knowledge.search.invalidate()
    },
    onError: (err) => setError(err.message),
  })

  const reset = trpc.knowledge.edit.reset.useMutation({
    onSuccess: () => {
      setProposal(null)
      setNotice('All in-app edits discarded — the imported baseline is live again.')
      setError(null)
      void utils.knowledge.status.invalidate()
      void utils.knowledge.search.invalidate()
    },
    onError: (err) => setError(err.message),
  })

  function submitInstruction(text: string) {
    const trimmed = text.trim()
    if (trimmed.length < 3 || propose.isPending) return
    setInstruction(trimmed)
    setProposal(null)
    setNotice(null)
    setError(null)
    propose.mutate({ instruction: trimmed })
  }

  function toggle(idx: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  async function onReset() {
    const ok = await confirm({
      title: 'Reset to the imported baseline?',
      body: 'Every in-app edit will be discarded and the knowledge base returns to exactly what was imported from the Crib. This cannot be undone from here.',
      confirmLabel: 'Reset everything',
      tone: 'danger',
    })
    if (ok) reset.mutate()
  }

  const selectedPatches =
    proposal?.patches.filter((_, idx) => selected.has(idx)) ?? []

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      {status.data ? (
        <p className="text-sm text-neutral-500">
          {status.data.edited
            ? `In-app edits are live${
                status.data.updatedAt
                  ? ` (last updated ${new Date(status.data.updatedAt).toLocaleString('en-GB')})`
                  : ''
              }.`
            : 'The imported Crib baseline is live — no in-app edits yet.'}{' '}
          {status.data.sectionCount} sections.
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          submitInstruction(instruction)
        }}
        className="flex flex-col gap-2"
      >
        <label htmlFor="knowledge-instruction" className="text-sm font-medium text-neutral-800">
          What should change?
        </label>
        <textarea
          id="knowledge-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={3}
          maxLength={2000}
          placeholder="e.g. Change the Platinum tier hours to 105, and note that the money-back guarantee needs all live days attended."
          className="min-h-[4.5rem] resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.slice(0, 2).map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setInstruction(example)}
                className="rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] text-neutral-600 transition-colors hover:border-primary-300 hover:text-primary-700"
              >
                {example}
              </button>
            ))}
          </div>
          <Button
            type="submit"
            disabled={propose.isPending || instruction.trim().length < 3}
          >
            <SparklesIcon size={16} />
            {propose.isPending ? 'Proposing…' : 'Propose changes'}
          </Button>
        </div>
      </form>

      {notice ? (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800"
        >
          {notice}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800"
        >
          {error}
        </p>
      ) : null}

      {proposal ? (
        <div className="rounded-xl border border-neutral-200 bg-white shadow-card">
          <div className="border-b border-neutral-100 px-5 py-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary-600">
              <SparklesIcon size={12} />
              AI proposal — review before applying
            </div>
            <p className="text-sm text-neutral-800">{proposal.summary}</p>
          </div>

          {proposal.patches.length === 0 ? (
            <p className="px-5 py-4 text-sm text-neutral-500">
              The AI proposed no changes — refine the instruction with the
              missing detail and try again.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {proposal.patches.map((patch, idx) => (
                <li key={`${patch.path}-${idx}`} className="flex gap-3 px-5 py-3">
                  <input
                    type="checkbox"
                    id={`patch-${idx}`}
                    checked={selected.has(idx)}
                    onChange={() => toggle(idx)}
                    className="mt-1 h-4 w-4 rounded border-neutral-300"
                  />
                  <label htmlFor={`patch-${idx}`} className="min-w-0 flex-1 cursor-pointer">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold uppercase ${OP_STYLES[patch.op]}`}
                      >
                        {patch.op}
                      </span>
                      <code className="break-all text-xs text-neutral-600">{patch.path}</code>
                    </div>
                    <div className="mt-1.5 grid gap-1 text-xs sm:grid-cols-2">
                      {patch.op !== 'add' ? (
                        <div>
                          <div className="text-[10px] font-semibold uppercase text-neutral-400">
                            Current
                          </div>
                          <pre className="whitespace-pre-wrap break-all rounded bg-neutral-50 p-1.5 text-neutral-600">
                            {preview(patch.current)}
                          </pre>
                        </div>
                      ) : null}
                      {patch.op !== 'remove' ? (
                        <div>
                          <div className="text-[10px] font-semibold uppercase text-neutral-400">
                            Proposed
                          </div>
                          <pre className="whitespace-pre-wrap break-all rounded bg-primary-50/50 p-1.5 text-neutral-800">
                            {preview(patch.value)}
                          </pre>
                        </div>
                      ) : null}
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          )}

          {proposal.patches.length > 0 ? (
            <div className="flex items-center justify-end gap-2 border-t border-neutral-100 px-5 py-3">
              <Button variant="ghost" type="button" onClick={() => setProposal(null)}>
                Discard
              </Button>
              <Button
                type="button"
                disabled={apply.isPending || selectedPatches.length === 0}
                onClick={() =>
                  apply.mutate({
                    patches: selectedPatches.map(({ op, path, value }) => ({
                      op,
                      path,
                      // `remove` carries no value; omit rather than send undefined.
                      ...(value === undefined ? {} : { value: value as KnowledgeValue }),
                    })),
                    summary: proposal.summary,
                  })
                }
              >
                {apply.isPending
                  ? 'Applying…'
                  : `Apply ${selectedPatches.length} change${selectedPatches.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="rounded-xl border border-dashed border-neutral-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-neutral-900">Reset</h2>
        <p className="mt-1 text-xs text-neutral-500">
          Discard every in-app edit and return to exactly what was imported
          from the Crib. Section pages, search and{' '}
          <Link href="/protocols/ask" className="text-primary-700 underline">
            AI Knowledge
          </Link>{' '}
          all follow immediately.
        </p>
        <Button
          variant="destructive"
          size="sm"
          type="button"
          className="mt-3"
          disabled={reset.isPending || status.data?.edited === false}
          onClick={() => void onReset()}
        >
          {reset.isPending ? 'Resetting…' : 'Reset to imported baseline'}
        </Button>
      </div>
    </div>
  )
}
