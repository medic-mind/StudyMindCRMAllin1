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
    href: '/reports/complaints',
    title: 'Complaints',
    description:
      'Open backlog, complaints raised and resolved over time, severity, theme and the customers with the most open complaints.',
  },
  {
    href: '/reports/finance',
    title: 'Finance',
    description:
      'Open discrepancies, money in/out by period, reconciliation lag percentile.',
  },
  {
    href: '/reports/operations',
    title: 'Operations',
    description: 'Sessions delivered vs scheduled, missed-session rate, hours.',
  },
  {
    href: '/reports/retention',
    title: 'Retention',
    description: 'Churn-score distribution, families at risk, churned this period.',
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
