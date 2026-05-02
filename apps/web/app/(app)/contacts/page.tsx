// Contacts list page. RSC: reads via the tRPC server-side caller.
// Pagination is URL-driven so links are shareable.

import Link from 'next/link'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'

import { createServerCaller } from '@/lib/trpc/server'

interface PageSearchParams {
  q?: string
  cursorId?: string
  cursorAt?: string
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

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <Link href="/contacts/new">
          <Button>New contact</Button>
        </Link>
      </div>

      <form className="mt-4 flex gap-2" method="GET">
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

      <div className="mt-6 rounded-md border border-neutral-200 bg-white">
        {data.items.length === 0 ? (
          <div className="p-6 text-sm text-neutral-600">
            No contacts yet — start by creating one with the button above.
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th>Role</Th>
                <Th>Email</Th>
                <Th>Phone</Th>
                <Th>Family</Th>
                <Th>Last interaction</Th>
              </Tr>
            </Thead>
            <Tbody>
              {data.items.map((c) => (
                <Tr key={c.id}>
                  <Td>
                    <Link href={`/contacts/${c.id}`} className="font-medium text-neutral-900 hover:underline">
                      {c.displayName}
                    </Link>
                  </Td>
                  <Td className="text-neutral-700">{c.kind}</Td>
                  <Td className="text-neutral-700">{c.email ?? '—'}</Td>
                  <Td className="font-mono text-neutral-700">{c.phoneE164 ?? '—'}</Td>
                  <Td className="text-neutral-700">{c.familyName ?? '—'}</Td>
                  <Td className="text-neutral-700">
                    {c.lastInteractionAt ? new Date(c.lastInteractionAt).toLocaleDateString('en-GB') : '—'}
                  </Td>
                </Tr>
              ))}
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
    </div>
  )
}
