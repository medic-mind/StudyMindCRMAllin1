// AI Knowledge chat (ADR 0040). Client leaf — conversation state lives
// here; every answer comes from `knowledge.ask`, which grounds the model
// on the imported knowledge base. Answers are labelled AI-generated
// (CLAUDE.md §4 — AI output is clearly marked; §18.2 — humans confirm).

'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { SparklesIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

interface Turn {
  role: 'user' | 'assistant'
  content: string
  related?: Array<{ slug: string; title: string }>
}

const SUGGESTIONS = [
  'What comes with the Platinum Full Application tier?',
  'How many complimentary hours can I offer on a 20-hour package?',
  'When are the UCAT live days in Manchester?',
  'Who handles a Summer Camp VIP enquiry?',
  'What do shadowing placements cost for one week?',
]

/** Turns sent back as conversation history (the server caps at 12). */
const HISTORY_WINDOW = 8

export function KnowledgeAssistant() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [question, setQuestion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const ask = trpc.knowledge.ask.useMutation({
    onSuccess: (data) => {
      setTurns((prev) => [
        ...prev,
        { role: 'assistant', content: data.answer, related: data.related },
      ])
      setError(null)
    },
    onError: (err) => {
      setError(err.message)
    },
  })

  // Keep the latest turn in view once the DOM has the new content.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [turns, ask.isPending])

  function submit(text: string) {
    const trimmed = text.trim()
    if (trimmed.length < 3 || ask.isPending) return
    const history = turns
      .slice(-HISTORY_WINDOW)
      .map(({ role, content }) => ({ role, content }))
    setTurns((prev) => [...prev, { role: 'user', content: trimmed }])
    setQuestion('')
    setError(null)
    ask.mutate({ question: trimmed, history })
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex h-[calc(100vh-280px)] min-h-[24rem] flex-col gap-4 overflow-y-auto bg-neutral-50/60 p-4">
      {turns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-200 bg-white p-6 text-center">
          <SparklesIcon size={24} className="mx-auto text-primary-500" />
          <h2 className="mt-2 text-sm font-semibold text-neutral-900">
            Ask the company knowledge base
          </h2>
          <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
            Answers come only from the imported Protocols &amp; Policies content
            — prices, dates and names are quoted verbatim, and the assistant
            says so when something is not covered.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => submit(suggestion)}
                className="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 transition-colors hover:border-primary-300 hover:text-primary-700"
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-3" aria-live="polite">
          {turns.map((turn, idx) =>
            turn.role === 'user' ? (
              <div key={idx} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary-600 px-4 py-2.5 text-sm text-white">
                  {turn.content}
                </div>
              </div>
            ) : (
              <div key={idx} className="flex justify-start">
                <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-neutral-200 bg-white px-4 py-3 shadow-sm">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary-600">
                    <SparklesIcon size={12} />
                    AI Knowledge
                  </div>
                  <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-800">
                    {turn.content}
                  </p>
                  {turn.related && turn.related.length > 0 ? (
                    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-neutral-100 pt-2">
                      <span className="text-[11px] text-neutral-400">Read more:</span>
                      {turn.related.map((section) => (
                        <Link
                          key={section.slug}
                          href={`/protocols/${section.slug}`}
                          className="rounded-full border border-neutral-200 px-2 py-0.5 text-[11px] text-neutral-600 transition-colors hover:border-primary-300 hover:text-primary-700"
                        >
                          {section.title}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ),
          )}
          {ask.isPending ? (
            <div className="flex justify-start">
              <div className="rounded-2xl rounded-bl-sm border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500 shadow-sm">
                Reading the knowledge base…
              </div>
            </div>
          ) : null}
          <div ref={bottomRef} />
        </div>
      )}

        {error ? (
          <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
            {error}
          </p>
        ) : null}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit(question)
        }}
        className="flex items-end gap-2 border-t border-neutral-200 bg-white p-3"
      >
        <label htmlFor="knowledge-question" className="sr-only">
          Your question
        </label>
        <textarea
          id="knowledge-question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit(question)
            }
          }}
          rows={2}
          maxLength={2000}
          placeholder="Ask about any product, price, date or policy…"
          className="min-h-[3rem] flex-1 resize-y rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
        />
        <Button type="submit" disabled={ask.isPending || question.trim().length < 3}>
          Ask
        </Button>
      </form>

      <p className="border-t border-neutral-100 bg-white px-3 pb-3 pt-2 text-xs text-neutral-400">
        AI-generated from the Protocols &amp; Policies knowledge base — check
        the linked section for the source, and always confirm live discount
        offers with Becca before quoting a customer.
      </p>
    </div>
  )
}
