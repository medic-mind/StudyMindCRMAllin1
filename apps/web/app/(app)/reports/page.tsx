// Reports landing. CLAUDE.md §27.

import Link from 'next/link'

import { PageHeader } from '@/components/shell/page-header'

const reports = [
  {
    href: '/reports/aircall',
    title: 'Aircall',
    description:
      'Call volume, peak times and agent performance — inbound/outbound, missed and voicemail. Export to PDF.',
  },
  {
    href: '/reports/cost',
    title: 'Cost',
    description: 'Weekly AI + storage cost summaries archived to S3.',
  },
]

export default function ReportsPage() {
  return (
    <>
      <PageHeader title="Reports" />
      <div className="grid gap-3 sm:grid-cols-2">
        {reports.map((r) => (
          <Link
            key={r.href}
            href={r.href}
            className="block rounded-md border border-neutral-200 bg-white p-4 hover:border-neutral-300"
          >
            <h2 className="font-medium">{r.title}</h2>
            <p className="mt-1 text-sm text-neutral-600">{r.description}</p>
          </Link>
        ))}
      </div>
    </>
  )
}
