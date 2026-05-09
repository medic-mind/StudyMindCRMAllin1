// Settings → Feature flags. RSC, admin | ops_manager.
// CLAUDE.md §31.

import { auth } from '@clerk/nextjs/server'
import Link from 'next/link'

import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { FlagToggle } from './toggle'

export const dynamic = 'force-dynamic'

export default async function FlagsSettingsPage() {
  const { sessionClaims } = await auth()
  const role = (sessionClaims?.['role'] as string | undefined) ?? 'agent'
  if (role !== 'admin' && role !== 'ops_manager') {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Feature flags</h1>
        <p className="mt-2 text-sm text-neutral-600">
          Restricted to administrators and ops managers.
        </p>
      </div>
    )
  }

  const caller = await createServerCaller()
  const data = await caller.admin.flags.list()

  const stale = data.items.filter((f) => f.stale)

  return (
    <div>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Feature flags</h1>
        <Link href="/settings" className="text-sm text-neutral-600 underline">
          Back to settings
        </Link>
      </div>

      {stale.length > 0 ? (
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>{stale.length} stale release flag{stale.length === 1 ? '' : 's'}</strong> —
          older than 30 days. Per CLAUDE.md §31, release flags should be removed
          within 30 days of full launch:
          <ul className="ml-4 list-disc">
            {stale.map((f) => (
              <li key={f.name}>
                <code className="font-mono text-xs">{f.name}</code> — {f.ageDays}d old
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-6 rounded-md border border-neutral-200 bg-white">
        <Table>
          <Thead>
            <Tr>
              <Th>Flag</Th>
              <Th>Kind</Th>
              <Th>Owner</Th>
              <Th>Source</Th>
              <Th>Effective</Th>
              <Th>Toggle</Th>
            </Tr>
          </Thead>
          <Tbody>
            {data.items.map((f) => (
              <Tr key={f.name}>
                <Td>
                  <div className="font-mono text-xs">{f.name}</div>
                  <div className="text-xs text-neutral-500">{f.description}</div>
                </Td>
                <Td>
                  <span
                    className={
                      f.kind === 'operational'
                        ? 'rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-800'
                        : 'rounded bg-purple-50 px-2 py-0.5 text-xs text-purple-800'
                    }
                  >
                    {f.kind}
                  </span>
                </Td>
                <Td className="text-xs">{f.owner}</Td>
                <Td className="text-xs">
                  {f.source}
                  {f.source === 'env' ? (
                    <span className="ml-1 text-neutral-500">({f.envKey})</span>
                  ) : null}
                </Td>
                <Td>
                  <span
                    className={
                      f.effective
                        ? 'rounded bg-green-100 px-2 py-0.5 text-xs text-green-800'
                        : 'rounded bg-neutral-100 px-2 py-0.5 text-xs text-neutral-700'
                    }
                  >
                    {f.effective ? 'on' : 'off'}
                  </span>
                </Td>
                <Td>
                  {f.source === 'env' ? (
                    <span className="text-xs text-neutral-500">env-pinned</span>
                  ) : (
                    <FlagToggle name={f.name} enabled={f.effective} />
                  )}
                </Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </div>
    </div>
  )
}
