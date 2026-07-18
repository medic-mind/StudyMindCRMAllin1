// In-shell 404 for the authenticated app. Rendered inside the (app) layout
// (sidebar + top bar stay), so a bad id or stale link lands somewhere friendly
// instead of the framework default. CLAUDE.md §4 (owned error/empty copy), §26.

import Link from 'next/link'

import { Card, CardBody } from '@/components/ui/card'
import { SearchIcon } from '@/components/ui/icon'

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center py-16 text-center">
      <Card className="w-full">
        <CardBody className="flex flex-col items-center gap-4 py-10">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-primary-600">
            <SearchIcon size={22} />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-neutral-900">
              We couldn&rsquo;t find that page
            </h1>
            <p className="mt-1 text-sm text-neutral-600">
              The record may have been moved, deleted, or the link is out of date.
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex h-9 items-center rounded-md bg-primary-600 px-4 text-sm font-medium text-white shadow-sm transition-colors hover:bg-primary-700"
          >
            Back to dashboard
          </Link>
        </CardBody>
      </Card>
    </div>
  )
}
