// /account/trengo/connect — agent pastes a fresh Trengo API token.
// CLAUDE.md §11. The token is validated against Trengo `/me`, KMS-envelope-
// encrypted, and persisted with a 90-day expiry. Reconnect resets the same
// row so the existing TrengoTokenBanner clears.

import Link from 'next/link'

import { TrengoConnectForm } from './form'

export const dynamic = 'force-dynamic'

export default function TrengoConnectPage() {
  return (
    <div className="max-w-xl space-y-4">
      <header>
        <h1 className="text-xl font-semibold text-neutral-900">Connect Trengo</h1>
        <p className="text-sm text-neutral-600">
          Paste a fresh personal API token from Trengo. We validate it, then
          encrypt it before saving — your token is never logged.
        </p>
      </header>

      <ol className="list-decimal space-y-1 pl-5 text-sm text-neutral-700">
        <li>
          Open Trengo · <span className="font-mono">Settings → API tokens</span>
        </li>
        <li>Generate a new personal token (90-day lifetime)</li>
        <li>Paste it below — submit only fires once you click Connect</li>
      </ol>

      <TrengoConnectForm />

      <p className="text-xs text-neutral-500">
        <Link href="/account" className="hover:underline">
          ← Back to account
        </Link>
      </p>
    </div>
  )
}
