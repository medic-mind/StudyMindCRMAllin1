// Settings → Feature flags. RSC, admin | ops_manager.
// CLAUDE.md §31.

import { legacyAuth as auth } from '@/lib/auth/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { FlagToggle } from './toggle'

const BREADCRUMBS = [
  { label: 'Settings', href: '/settings' },
  { label: 'Flags', href: '/settings/flags' },
]

export const dynamic = 'force-dynamic'

export default async function FlagsSettingsPage() {
  const { sessionClaims } = await auth()
  const role = (sessionClaims?.['role'] as string | undefined) ?? 'agent'
  if (role !== 'admin' && role !== 'ops_manager') {
    return (
      <>
        <PageHeader title="Feature flags" breadcrumbs={BREADCRUMBS} />
        <PageBody>
          <p className="text-sm text-neutral-600">
            Restricted to administrators and ops managers.
          </p>
        </PageBody>
      </>
    )
  }

  const caller = await createServerCaller()
  const data = await caller.admin.flags.list()

  const stale = data.items.filter((f) => f.stale)

  return (
    <>
      <PageHeader title="Feature flags" breadcrumbs={BREADCRUMBS} />
      <PageBody>
      {stale.length > 0 ? (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
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

      <div className="mt-6 rounded-md border border-neutral-200 bg-white shadow-card">
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
                        ? 'rounded bg-primary-50 px-2 py-0.5 text-xs text-primary-800'
                        : 'rounded bg-violet-50 px-2 py-0.5 text-xs text-violet-800'
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
      </PageBody>
    </>
  )
}
