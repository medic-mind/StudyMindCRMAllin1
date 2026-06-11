// Debounced keyword search over the imported knowledge base (ADR 0040).
// Client leaf (CLAUDE.md §26) — the index itself stays server-side; this
// island only sends the query through tRPC and renders the matches.

'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

import { SearchIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

export function KnowledgeSearch() {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(handle)
  }, [query])

  const enabled = debounced.length >= 2
  const search = trpc.knowledge.search.useQuery(
    { query: debounced },
    { enabled, placeholderData: (prev) => prev },
  )

  const results = enabled ? (search.data?.results ?? []) : []

  return (
    <div>
      <label htmlFor="knowledge-search" className="sr-only">
        Search the knowledge base
      </label>
      <div className="relative">
        <SearchIcon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
        />
        <input
          id="knowledge-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search prices, dates, scripts, policies… (e.g. “Platinum guarantee”, “UCAT live day Manchester”)"
          className="h-10 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-sm text-neutral-900 shadow-sm placeholder:text-neutral-400 focus:border-primary-400 focus:outline-none focus:ring-2 focus:ring-primary-100"
        />
      </div>

      {enabled ? (
        <div
          className="mt-2 rounded-lg border border-neutral-200 bg-white shadow-sm"
          aria-live="polite"
        >
          {search.isLoading ? (
            <p className="px-4 py-3 text-sm text-neutral-500">Searching…</p>
          ) : results.length === 0 ? (
            <p className="px-4 py-3 text-sm text-neutral-500">
              No matches for “{debounced}” — try a different word, or ask AI
              Knowledge instead.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {results.map((result) => (
                <li key={`${result.sectionSlug}-${result.path}`}>
                  <Link
                    href={`/protocols/${result.sectionSlug}`}
                    className="block px-4 py-2.5 transition-colors hover:bg-neutral-50"
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <span className="font-semibold text-primary-700">
                        {result.sectionTitle}
                      </span>
                      {result.path ? (
                        <span className="text-neutral-400">{result.path}</span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-sm text-neutral-700">
                      {result.snippet}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
