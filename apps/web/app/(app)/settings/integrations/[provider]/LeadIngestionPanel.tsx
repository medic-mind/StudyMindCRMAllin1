'use client'

// Contact-Form-7 / universal lead ingestion control panel (ADR 0023). Shown on
// Settings → Integrations → Lead webhook. Surfaces the copy-paste endpoint URL,
// per-website API keys (create / rotate / archive / delete — raw key shown once), and a
// one-click test-lead generator. Manager+ (the page already gates this).

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { trpc } from '@/lib/trpc/client'

function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-neutral-600">{label}</div>
      <div className="mt-1 flex items-stretch gap-2">
        <code className="flex-1 truncate rounded border border-neutral-200 bg-neutral-50 px-2 py-1.5 font-mono text-xs text-neutral-800">
          {value}
        </code>
        <Button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(value)
            toast.success('Copied')
          }}
        >
          Copy
        </Button>
      </div>
    </div>
  )
}

export function LeadIngestionPanel() {
  const [origin, setOrigin] = useState('https://crm.studymind.co.uk')
  const [newName, setNewName] = useState('')
  const [freshKey, setFreshKey] = useState<{ name: string; key: string } | null>(null)

  useEffect(() => {
    if (typeof window !== 'undefined') setOrigin(window.location.origin)
  }, [])

  const utils = trpc.useUtils()
  const sources = trpc.lead.sources.list.useQuery()

  const create = trpc.lead.sources.create.useMutation({
    onSuccess: async (r) => {
      setFreshKey({ name: newName, key: r.key })
      setNewName('')
      await utils.lead.sources.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const rotate = trpc.lead.sources.rotate.useMutation({
    onSuccess: async (r) => {
      setFreshKey({ name: 'Rotated key', key: r.key })
      await utils.lead.sources.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const archive = trpc.lead.sources.archive.useMutation({
    onSuccess: async () => {
      toast.success('Source archived')
      await utils.lead.sources.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const remove = trpc.lead.sources.delete.useMutation({
    onSuccess: async () => {
      toast.success('API key deleted')
      await utils.lead.sources.list.invalidate()
    },
    onError: (e) => toast.error(e.message),
  })
  const sendTest = trpc.lead.sendTest.useMutation({
    onSuccess: (r) =>
      r.deduped
        ? toast.success('Test accepted (deduped)')
        : toast.success('Test lead sent — check the Leads tray'),
    onError: (e) => toast.error(e.message),
  })

  const endpoint = `${origin}/api/leads`

  return (
    <section className="space-y-6">
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
          Webhook URL
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Paste this into Contact Form 7 → your form → the Webhook URL box. It accepts any field
          layout — no developer changes needed when forms differ. Authenticate with a per-site API
          key below (send it as an <code className="font-mono">Authorization: Bearer …</code>{' '}
          header, an <code className="font-mono">X-API-Key</code> header, or a{' '}
          <code className="font-mono">?key=</code> query param).
        </p>
        <div className="mt-3 space-y-3">
          <CopyField value={endpoint} label="Endpoint" />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={() => sendTest.mutate(undefined)}
              disabled={sendTest.isPending}
            >
              {sendTest.isPending ? 'Sending…' : 'Send test lead'}
            </Button>
            <Link href="/leads" className="text-xs text-primary-700 hover:underline">
              Open the Leads tray →
            </Link>
          </div>
        </div>
      </div>

      {freshKey ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="text-sm font-semibold text-amber-900">
            New key for “{freshKey.name}” — copy it now
          </div>
          <p className="mt-1 text-xs text-amber-800">
            This is the only time the full key is shown. Store it in the form’s webhook config and
            1Password.
          </p>
          <div className="mt-2">
            <CopyField value={freshKey.key} label="API key" />
          </div>
          <button
            type="button"
            className="mt-2 text-xs text-amber-900 underline"
            onClick={() => setFreshKey(null)}
          >
            I’ve copied it — hide
          </button>
        </div>
      ) : null}

      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-700">
          Site API keys
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          One key per website or form. Optionally pin a brand so leads from that site always route
          to it regardless of domain detection.
        </p>

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="grow">
            <Input
              placeholder="New source name (e.g. Medic Mind UCAT landing)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>
          <Button
            type="button"
            disabled={!newName.trim() || create.isPending}
            onClick={() => create.mutate({ name: newName.trim() })}
          >
            {create.isPending ? 'Creating…' : 'Create key'}
          </Button>
        </div>

        <Card className="mt-3 overflow-hidden">
          <Table>
            <Thead>
              <Tr>
                <Th>Source</Th>
                <Th>Key</Th>
                <Th>Brand</Th>
                <Th>Leads</Th>
                <Th>State</Th>
                <Th></Th>
              </Tr>
            </Thead>
            <Tbody>
              {(sources.data ?? []).map((s) => (
                <Tr key={s.id}>
                  <Td className="font-medium text-neutral-900">{s.name}</Td>
                  <Td className="font-mono text-xs text-neutral-500">…{s.keyLast4}</Td>
                  <Td>{s.defaultBrand?.name ?? <span className="text-neutral-400">auto</span>}</Td>
                  <Td className="tabular-nums">{s.leadCount}</Td>
                  <Td>
                    {s.archived ? (
                      <Badge tone="neutral">archived</Badge>
                    ) : s.active ? (
                      <Badge tone="success">active</Badge>
                    ) : (
                      <Badge tone="warn">disabled</Badge>
                    )}
                  </Td>
                  <Td>
                    <div className="flex justify-end gap-2">
                      {!s.archived ? (
                        <>
                          <button
                            type="button"
                            className="text-xs text-primary-700 hover:underline"
                            onClick={() => rotate.mutate({ id: s.id })}
                          >
                            Rotate
                          </button>
                          <button
                            type="button"
                            className="text-xs text-neutral-600 hover:underline"
                            onClick={() => archive.mutate({ id: s.id })}
                          >
                            Archive
                          </button>
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="text-xs text-red-600 hover:underline"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Delete the API key “${s.name}”? It stops working immediately and can't be undone. Past leads are kept.`,
                            )
                          ) {
                            remove.mutate({ id: s.id })
                          }
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </Td>
                </Tr>
              ))}
              {(sources.data ?? []).length === 0 ? (
                <Tr>
                  <Td colSpan={6} className="text-sm text-neutral-500">
                    No API keys yet. Create one above, then paste the endpoint + key into your
                    Contact Form 7 webhook.
                  </Td>
                </Tr>
              ) : null}
            </Tbody>
          </Table>
        </Card>
      </div>
    </section>
  )
}
