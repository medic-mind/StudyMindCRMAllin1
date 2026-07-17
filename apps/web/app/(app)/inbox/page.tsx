// Trengo gateway (2026-07). The embedded in-app Trengo conversation view was
// replaced at the operator's request with a simple hand-off to the real Trengo
// app — staff log in and work there directly. The sync layer (webhooks + the
// reconcile cron) still mirrors Trengo activity onto customer timelines behind
// the scenes; this page is just the door to Trengo itself.

import { ArrowUpRightIcon, MessageSquareIcon } from '@/components/ui/icon'

export const dynamic = 'force-dynamic'

const TRENGO_URL = 'https://app.trengo.com'
const HR_APP_URL = 'https://hr.studymind.co.uk'

export default function TrengoGatewayPage() {
  return (
    <div className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-primary-50 text-primary-600">
        <MessageSquareIcon size={32} />
      </span>

      <h1 className="mt-6 text-2xl font-semibold tracking-tight text-neutral-900">
        Open Trengo
      </h1>
      <p className="mt-2 text-sm text-neutral-600">
        WhatsApp, SMS, web-chat and email conversations are handled in Trengo.
        Sign in there to read and reply — everything you do stays in sync with
        the customer timelines here.
      </p>

      <a
        href={TRENGO_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-8 inline-flex items-center gap-2 rounded-xl bg-primary-600 px-8 py-4 text-base font-semibold text-white shadow-sm transition-colors hover:bg-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2"
      >
        Go to Trengo
        <ArrowUpRightIcon size={20} />
      </a>
      <p className="mt-2 text-xs text-neutral-400">Opens app.trengo.com in a new tab</p>

      <div className="mt-10 w-full rounded-xl border border-neutral-200 bg-neutral-50 p-5 text-left">
        <h2 className="text-sm font-semibold text-neutral-900">
          Don&apos;t have Trengo access yet?
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Trengo accounts are set up by a manager. To get access, ask your
          manager directly, or request it through the HR app.
        </p>
        <a
          href={HR_APP_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary-700 hover:underline"
        >
          Request access on the HR app
          <ArrowUpRightIcon size={14} />
        </a>
        <p className="mt-1 text-xs text-neutral-400">hr.studymind.co.uk</p>
      </div>
    </div>
  )
}
