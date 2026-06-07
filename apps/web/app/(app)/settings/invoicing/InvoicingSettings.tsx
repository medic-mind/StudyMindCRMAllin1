// Settings → Invoicing client island. Connection badge + credential form +
// live connection test. Secrets are write-only from the UI: we show the API
// key's last 4 chars but never the full value (CLAUDE.md §21). CEO / Senior
// Manager only (gated again server-side).

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

interface StatusShape {
  baseUrl: string
  configured: boolean
  webhookSecretConfigured: boolean
  apiKeyLast4: string | null
  eventsCursor: string | null
  streamCursor: string | null
  customerCount: number
  invoiceCount: number
  lastEventAt: Date | null
  lastEventType: string | null
}

function timeAgo(d: Date | string | null): string {
  if (!d) return 'never'
  const ms = Date.now() - new Date(d).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}

export function InvoicingSettings({ initial }: { initial: StatusShape }) {
  const router = useRouter()
  const status = trpc.invoicing.config.status.useQuery(undefined, { initialData: initial })
  const data = status.data ?? initial

  const [baseUrl, setBaseUrl] = useState(data.baseUrl)
  const [apiKey, setApiKey] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')

  const save = trpc.invoicing.config.save.useMutation()
  const test = trpc.invoicing.config.test.useMutation()
  const importAccounts = trpc.invoicing.config.importAccounts.useMutation()
  const resyncInvoices = trpc.invoicing.config.resyncInvoices.useMutation()

  const [testResult, setTestResult] = useState<string | null>(null)

  const [importResult, setImportResult] = useState<string | null>(null)

  async function handleImport() {
    setImportResult(null)
    try {
      const r = await importAccounts.mutateAsync()
      const total = (r.created ?? 0) + (r.adopted ?? 0) + (r.updated ?? 0)
      if ((r.scanned ?? 0) === 0) {
        const msg =
          'Connected, but the platform returned no B2B customers to import. (b2c and AP/council customers are not imported here.)'
        setImportResult(msg)
        toast.message(msg)
      } else {
        const invoicePart = (r.invoicesImported ?? 0) > 0 ? ` · ${r.invoicesImported} invoices` : ''
        const msg = `Imported ${total} account${total === 1 ? '' : 's'} — ${r.created ?? 0} new, ${r.adopted ?? 0} linked, ${r.updated ?? 0} updated${
          (r.needsClassification ?? 0) > 0 ? `, ${r.needsClassification} to classify` : ''
        }${invoicePart}.`
        setImportResult(msg)
        toast.success(msg)
      }
      await status.refetch()
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not import'
      setImportResult(msg)
      toast.error(msg)
    }
  }

  async function handleResyncInvoices() {
    setImportResult(null)
    try {
      const r = await resyncInvoices.mutateAsync()
      const msg = `Re-synced ${r.scanned ?? 0} invoice${(r.scanned ?? 0) === 1 ? '' : 's'} — paid invoices now show the correct outstanding balance.`
      setImportResult(msg)
      toast.success(msg)
      await status.refetch()
      router.refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not re-sync invoices'
      setImportResult(msg)
      toast.error(msg)
    }
  }

  // The webhook receiver URL is this CRM's own origin + the route path. We read
  // it from the browser so it is always correct for whatever domain the app is
  // served on (prod, staging, preview) without hard-coding it.
  const receiverUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/webhooks/invoicing`
      : '/api/webhooks/invoicing'
  const [copied, setCopied] = useState(false)
  async function copyReceiverUrl() {
    try {
      await navigator.clipboard.writeText(receiverUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard API can be blocked; the URL is visible to select manually.
    }
  }

  async function handleSave() {
    try {
      await save.mutateAsync({
        baseUrl: baseUrl.trim() || undefined,
        // Only send a secret when the user typed one — empty leaves it intact.
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        webhookSecret: webhookSecret.trim() ? webhookSecret.trim() : undefined,
      })
      toast.success('Invoicing settings saved')
      setApiKey('')
      setWebhookSecret('')
      await status.refetch()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save')
    }
  }

  async function handleTest() {
    setTestResult(null)
    try {
      const res = await test.mutateAsync()
      const scopeText = res.scopes.length ? ` · scopes: ${res.scopes.join(', ')}` : ''
      setTestResult(
        `Connected to ${res.name ?? 'platform'}${res.version ? ` v${res.version}` : ''}${scopeText}`,
      )
      toast.success('Connection OK')
      await status.refetch()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Connection failed'
      setTestResult(msg)
      toast.error(msg)
    }
  }

  const badge = data.configured
    ? { tone: 'bg-emerald-100 text-emerald-900', label: 'Connected' }
    : { tone: 'bg-neutral-100 text-neutral-700', label: 'Not configured' }

  return (
    <div className="max-w-2xl space-y-5">
      {/* Connection status */}
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-900">Connection</h2>
            <p className="mt-1 text-sm text-neutral-500">
              {data.configured
                ? `API key ending …${data.apiKeyLast4 ?? '????'}`
                : 'No API key set yet.'}
            </p>
          </div>
          <span className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${badge.tone}`}>
            {badge.label}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-neutral-500">Webhook secret</dt>
            <dd className="font-mono text-neutral-800">
              {data.webhookSecretConfigured ? 'set' : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-neutral-500">Customers</dt>
            <dd className="font-mono tabular-nums text-neutral-800">{data.customerCount}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Invoices</dt>
            <dd className="font-mono tabular-nums text-neutral-800">{data.invoiceCount}</dd>
          </div>
          <div>
            <dt className="text-neutral-500">Last event</dt>
            <dd className="font-mono text-neutral-800">{timeAgo(data.lastEventAt)}</dd>
          </div>
        </dl>
        <div className="mt-4 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={test.isPending || !data.configured}
            onClick={handleTest}
          >
            {test.isPending ? 'Testing…' : 'Send test event'}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={importAccounts.isPending || !data.configured}
            onClick={handleImport}
          >
            {importAccounts.isPending ? 'Starting…' : 'Pull historic data'}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={resyncInvoices.isPending || !data.configured}
            onClick={handleResyncInvoices}
          >
            {resyncInvoices.isPending ? 'Re-syncing…' : 'Re-sync invoices'}
          </Button>
          {testResult && (
            <span className="font-mono text-[11px] text-neutral-600">{testResult}</span>
          )}
        </div>
        {importResult && (
          <p className="mt-2 rounded-md bg-neutral-50 px-3 py-2 text-xs text-neutral-700 ring-1 ring-neutral-200">
            {importResult}
          </p>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          “Pull historic data” imports every B2B customer from the invoicing platform as a School or
          B2B Partner account. Safe to run more than once — it never creates duplicates. Anything it
          can’t auto-classify lands in the Unsorted tray on the Accounts page.
        </p>
      </div>

      {/* Credentials */}
      <div className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">
        <h2 className="text-sm font-semibold text-neutral-900">Credentials</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Paste the API key the invoicing team minted for you (read+write) and the webhook signing
          secret they returned after you registered this CRM&rsquo;s receiver. Stored encrypted;
          never shown again.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="invoicing-base-url"
              className="block text-xs font-medium text-neutral-700"
            >
              Base URL
            </label>
            <Input
              id="invoicing-base-url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://b2b.studymind.co.uk"
              className="mt-1"
            />
          </div>

          <div>
            <label
              htmlFor="invoicing-api-key"
              className="block text-xs font-medium text-neutral-700"
            >
              API key (sk_live_…)
            </label>
            <Input
              id="invoicing-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={data.configured ? '•••••••• (leave blank to keep)' : 'sk_live_…'}
              className="mt-1 font-mono"
            />
          </div>

          <div>
            <label
              htmlFor="invoicing-webhook-secret"
              className="block text-xs font-medium text-neutral-700"
            >
              Webhook secret (whsec_…)
            </label>
            <Input
              id="invoicing-webhook-secret"
              type="password"
              autoComplete="off"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={
                data.webhookSecretConfigured ? '•••••••• (leave blank to keep)' : 'whsec_…'
              }
              className="mt-1 font-mono"
            />
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" size="sm" disabled={save.isPending} onClick={handleSave}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>

      {/* Webhook receiver hint */}
      <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-600">
          Webhook receiver
        </h3>
        <p className="mt-2 text-sm text-neutral-600">
          In the invoicing platform → Settings → API &amp; Integrations → Add webhook, set the URL
          to this CRM&rsquo;s receiver and subscribe to <span className="font-mono">*</span> (all
          topics):
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="block flex-1 rounded bg-white px-3 py-2 font-mono text-xs text-neutral-800 ring-1 ring-neutral-200">
            {receiverUrl}
          </code>
          <Button type="button" size="sm" variant="ghost" onClick={copyReceiverUrl}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <p className="mt-3 text-xs text-neutral-500">
          When you save that webhook, the platform generates a signing secret (
          <span className="font-mono">whsec_…</span>) and shows it to you once. Copy it and paste it
          into the <strong>Webhook secret</strong> field above, then Save. You don&rsquo;t create
          the secret yourself — it comes from them.
        </p>
      </div>
    </div>
  )
}
