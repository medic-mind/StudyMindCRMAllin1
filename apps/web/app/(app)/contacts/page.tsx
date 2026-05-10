// Contacts list page. RSC: reads via the tRPC server-side caller.
// Pagination is URL-driven so links are shareable.

import Link from 'next/link'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Avatar } from '@/components/ui/avatar'
import { Badge, type BadgeTone } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

interface PageSearchParams {
  q?: string
  cursorId?: string
  cursorAt?: string
}

const KIND_TONE: Record<string, BadgeTone> = {
  parent: 'info',
  student: 'accent',
  tutor: 'success',
  la_caseworker: 'warn',
  other: 'neutral',
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
  const data = await caller.contact.list({
    cursor,
    limit: 25,
    q: sp.q && sp.q.trim() ? sp.q.trim() : undefined,
  })
  const now = new Date()

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
          <Input
            type="search"
            name="q"
            defaultValue={sp.q ?? ''}
            placeholder="Search by name, email, or phone"
            className="max-w-sm"
          />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>

        <div className="mt-6 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
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
                  <Th>Role</Th>
                  <Th>Family</Th>
                  <Th>Last interaction</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.items.map((c) => {
                  const tone = KIND_TONE[c.kind] ?? 'neutral'
                  return (
                    <Tr key={c.id}>
                      <Td>
                        <Link
                          href={`/contacts/${c.id}`}
                          className="flex min-w-0 items-center gap-3"
                        >
                          <Avatar name={c.displayName} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium text-neutral-900 group-hover:text-primary-800">
                              {c.displayName}
                            </span>
                            <span className="block truncate text-xs text-neutral-500">
                              {c.email ?? '—'}
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
                        <Badge tone={tone}>{c.kind}</Badge>
                      </Td>
                      <Td className="text-sm text-neutral-700">
                        {c.familyName ?? <span className="text-neutral-400">—</span>}
                      </Td>
                      <Td className="font-mono text-xs tabular-nums text-neutral-500">
                        {c.lastInteractionAt
                          ? formatRelativeTime(new Date(c.lastInteractionAt), now)
                          : '—'}
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
