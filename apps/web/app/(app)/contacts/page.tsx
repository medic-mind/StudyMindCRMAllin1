// Contacts list page. RSC: reads via the tRPC server-side caller.
// Pagination is URL-driven so links are shareable.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChevronRightIcon, SearchIcon, UsersIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

interface PageSearchParams {
  q?: string
  cursorId?: string
  cursorAt?: string
  company?: string
}

/** A row from `trpc.company.pickList`. */
interface CompanyOption {
  id: string
  name: string
  slug: string
  color: string | null
}

const KIND_TONE: Record<string, BadgeTone> = {
  parent: 'info',
  student: 'accent',
  tutor: 'success',
  la_caseworker: 'warn',
  other: 'neutral',
}

const KIND_RING: Record<string, string> = {
  parent: 'ring-primary-100',
  student: 'ring-violet-100',
  tutor: 'ring-emerald-100',
  la_caseworker: 'ring-amber-100',
  other: 'ring-neutral-100',
}

function formatKind(kind: string): string {
  return kind.replace(/_/g, ' ')
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<PageSearchParams>
}) {
  const sp = await searchParams
  const caller = await createServerCaller()
  const cursor =
    sp.cursorId && sp.cursorAt
      ? { id: sp.cursorId, createdAt: new Date(sp.cursorAt) }
      : undefined
  const companies: CompanyOption[] = await caller.company.pickList()
  const bySlug = new Map(companies.map((c) => [c.slug, c]))
  const activeCompany =
    sp.company && bySlug.has(sp.company) ? (bySlug.get(sp.company) as CompanyOption) : undefined
  const data = await caller.contact.list({
    cursor,
    limit: 25,
    q: sp.q && sp.q.trim() ? sp.q.trim() : undefined,
    companyId: activeCompany?.id,
  })
  const now = new Date()

  function chipHref(next: CompanyOption | undefined): {
    pathname: string
    query: Record<string, string>
  } {
    const q: Record<string, string> = {}
    if (sp.q) q.q = sp.q
    if (next) q.company = next.slug
    return { pathname: '/contacts', query: q }
  }

  return (
    <>
      <PageHeader
        title="Contacts"
        subtitle={`${data.items.length} on this page${sp.q ? ` matching “${sp.q}”` : ''}`}
        actions={
          <Link href="/contacts/new">
            <Button>New contact</Button>
          </Link>
        }
      />
      <PageBody>
        <form className="flex gap-2" method="GET">
          <div className="relative max-w-sm flex-1">
            <SearchIcon
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
            />
            <Input
              type="search"
              name="q"
              defaultValue={sp.q ?? ''}
              placeholder="Search by name, email, or phone"
              className="pl-9"
            />
          </div>
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        {/* Company filter chips */}
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <Link
            href={chipHref(undefined)}
            className={
              !activeCompany
                ? 'inline-flex items-center rounded-full bg-neutral-900 px-3 py-1 text-xs font-medium text-white'
                : 'inline-flex items-center rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900'
            }
          >
            All companies
          </Link>
          {companies.map((c) => {
            const active = activeCompany?.id === c.id
            return (
              <Link
                key={c.id}
                href={chipHref(c)}
                className={
                  active
                    ? 'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-white'
                    : 'inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50'
                }
                style={active ? { backgroundColor: c.color ?? '#475569' } : undefined}
              >
                <span
                  aria-hidden
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: c.color ?? '#94a3b8' }}
                />
                {c.name}
              </Link>
            )
          })}
        </div>

        <div className="mt-4 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
          {data.items.length === 0 ? (
            <div className="p-10 text-center">
              <p className="text-sm font-medium text-neutral-700">
                {sp.q ? 'No contacts match this search.' : 'No contacts yet.'}
              </p>
              <p className="mt-1 text-sm text-neutral-500">
                {sp.q
                  ? 'Try a different name, email, or phone fragment.'
                  : 'Start by creating one with the button above, or wait for an inbound lead to convert.'}
              </p>
            </div>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Contact</Th>
                  <Th>Type</Th>
                  <Th>Family</Th>
                  <Th className="text-right">Last activity</Th>
                  <Th className="w-8" aria-label="Open" />
                </Tr>
              </Thead>
              <Tbody>
                {data.items.map((c) => {
                  const tone = KIND_TONE[c.kind] ?? 'neutral'
                  const ring = KIND_RING[c.kind] ?? 'ring-neutral-100'
                  return (
                    <Tr key={c.id} className="group">
                      <Td>
                        <Link
                          href={`/contacts/${c.id}`}
                          className="flex min-w-0 items-center gap-3"
                        >
                          <Avatar name={c.displayName} size={36} className={`ring-2 ${ring}`} />
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5">
                              {c.companies.length > 0 ? (
                                <span
                                  className="flex shrink-0 items-center gap-0.5"
                                  title={c.companies.map((cc) => cc.name).join(' · ')}
                                  aria-label={`Companies: ${c.companies.map((cc) => cc.name).join(', ')}`}
                                >
                                  {c.companies.slice(0, 3).map((cc) => (
                                    <span
                                      key={cc.id}
                                      aria-hidden
                                      className="h-2 w-2 rounded-full"
                                      style={{ backgroundColor: cc.color ?? '#94a3b8' }}
                                    />
                                  ))}
                                </span>
                              ) : null}
                              <span className="block truncate font-medium text-neutral-900 group-hover:text-primary-700">
                                {c.displayName}
                              </span>
                            </span>
                            <span className="block truncate text-xs text-neutral-500">
                              {c.email ?? <span className="text-neutral-400">no email</span>}
                              {c.phoneE164 ? (
                                <>
                                  {' · '}
                                  <span className="font-mono">{c.phoneE164}</span>
                                </>
                              ) : null}
                            </span>
                          </span>
                        </Link>
                      </Td>
                      <Td>
                        <Badge tone={tone}>{formatKind(c.kind)}</Badge>
                      </Td>
                      <Td className="text-sm">
                        {c.familyId ? (
                          <Link
                            href={`/contacts/families/${c.familyId}`}
                            className="inline-flex items-center gap-1.5 text-neutral-700 hover:text-primary-700 hover:underline"
                          >
                            <UsersIcon size={13} className="text-neutral-400" />
                            <span className="truncate">{c.familyName ?? 'Family'}</span>
                          </Link>
                        ) : (
                          <span className="text-neutral-400">—</span>
                        )}
                      </Td>
                      <Td
                        className="text-right font-mono text-xs tabular-nums text-neutral-500"
                        title={
                          c.lastInteractionAt
                            ? new Date(c.lastInteractionAt).toISOString()
                            : undefined
                        }
                      >
                        {c.lastInteractionAt
                          ? formatRelativeTime(new Date(c.lastInteractionAt), now)
                          : '—'}
                      </Td>
                      <Td className="text-right">
                        <Link
                          href={`/contacts/${c.id}`}
                          aria-label={`Open ${c.displayName}`}
                          className="inline-flex text-neutral-300 transition-colors group-hover:text-primary-600"
                        >
                          <ChevronRightIcon size={16} />
                        </Link>
                      </Td>
                    </Tr>
                  )
                })}
              </Tbody>
            </Table>
          )}
        </div>

        {data.nextCursor && (
          <div className="mt-4 flex justify-end">
            <Link
              href={{
                pathname: '/contacts',
                query: {
                  ...(sp.q ? { q: sp.q } : {}),
                  cursorId: data.nextCursor.id,
                  cursorAt: data.nextCursor.createdAt.toISOString(),
                },
              }}
            >
              <Button variant="secondary">Next page</Button>
            </Link>
          </div>
        )}
      </PageBody>
    </>
  )
}
