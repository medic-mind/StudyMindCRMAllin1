// Webinars overview. At-a-glance health of the weekly-class auto-enrollment
// system: groups, classes this week, live enrolments, the review queue,
// expiring subscriptions, and Zoom links due for rotation.

import Link from 'next/link'

import { Card, CardBody } from '@/components/ui/card'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

function Stat({
  label,
  value,
  href,
  tone,
}: {
  label: string
  value: number | string
  href?: string
  tone?: 'warn' | 'danger'
}) {
  const body = (
    <Card className="transition-shadow hover:shadow-md">
      <CardBody>
        <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">{label}</div>
        <div
          className={
            'mt-1 text-2xl font-semibold tabular-nums ' +
            (tone === 'danger'
              ? 'text-red-700'
              : tone === 'warn'
                ? 'text-amber-700'
                : 'text-neutral-900')
          }
        >
          {value}
        </div>
      </CardBody>
    </Card>
  )
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  )
}

const SUBJECT_TITLE = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export default async function WebinarsOverviewPage() {
  const caller = await createServerCaller()
  const [o, rotationDue] = await Promise.all([
    caller.webinar.overview(),
    caller.webinar.zoom.rotationDue(),
  ])

  return (
    <>
      <PageHeader
        title="Webinars"
        subtitle="Weekly live classes — auto-enrol Stripe payers, email the Zoom link + PDF schedule each week, and stop when a subscription lapses."
        breadcrumbs={[{ label: 'Webinars', href: '/webinars' }]}
      />
      <PageBody>
        <Card className="mb-4 border-primary-100 bg-primary-50/40">
          <CardBody>
            <p className="text-sm text-neutral-700">
              Manage everything from{' '}
              <Link href="/webinars/groups" className="font-medium text-primary-700 underline">
                Groups
              </Link>{' '}
              — each group is a subject + level (e.g. A-Level Biology) with its own weekly classes,
              Zoom link, template, settings and students. Import a timetable to set one up in
              seconds.
            </p>
          </CardBody>
        </Card>

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          <Stat label="Groups" value={o.classCount} href="/webinars/groups" />
          <Stat label="Classes this week" value={o.sessionsThisWeek} href="/webinars/groups" />
          <Stat label="Active enrolments" value={o.activeEnrollments} href="/webinars/enrollments" />
          <Stat
            label="Awaiting review"
            value={o.pendingReview}
            href="/webinars/enrollments?view=review"
            tone={o.pendingReview > 0 ? 'warn' : undefined}
          />
          <Stat
            label="Expiring in 7 days"
            value={o.expiringSoon}
            tone={o.expiringSoon > 0 ? 'warn' : undefined}
          />
          <Stat
            label="Zoom links to rotate"
            value={o.zoomRotationDue}
            href="/webinars/groups"
            tone={o.zoomRotationDue > 0 ? 'danger' : undefined}
          />
          <Stat label="Emails sent (7 days)" value={o.emailsSentLast7Days} />
        </div>

        {rotationDue.length > 0 ? (
          <Card className="mt-6 border-amber-200 bg-amber-50/40">
            <CardBody>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-neutral-900">
                  Zoom links to rotate ({rotationDue.length})
                </h2>
                <span className="text-xs text-neutral-500">
                  Auto-rotation handles most of these; the ones below need a person.
                </span>
              </div>
              <ul className="mt-3 divide-y divide-amber-100">
                {rotationDue.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0">
                      <Link
                        href="/webinars/groups"
                        className="text-sm font-medium text-neutral-900 hover:text-primary-700 hover:underline"
                      >
                        {SUBJECT_TITLE(c.subject)} {c.level.toUpperCase()} — {c.title}
                      </Link>
                      <span className="block text-xs text-neutral-500">
                        {c.autoRotate && c.hasLink
                          ? 'Auto-rotation on — the weekly job will rotate it.'
                          : !c.hasLink
                            ? 'No Zoom link yet — set one up on the group page.'
                            : 'Auto-rotation off — rotate the link manually on the group page.'}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-amber-700 ring-1 ring-amber-200">
                      every {c.zoomRotateEveryWeeks}w
                    </span>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ) : null}

        <Card className="mt-6">
          <CardBody>
            <h2 className="text-sm font-semibold text-neutral-900">How it works</h2>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-neutral-600">
              <li>
                Create a <strong>group</strong> per subject &amp; level — fastest is to import its
                timetable (CSV/PDF) on the Groups page, which fills in the weekly classes, term dates
                and holidays for you.
              </li>
              <li>
                Open the group to set its weekly slot, Zoom link, reminder email and weekly class
                topics — all on one page.
              </li>
              <li>
                Press <strong>Detect from Stripe</strong> on Enrolments — the app reads your active
                subscriptions (name, description and metadata, monthly or yearly), works out the
                subject &amp; level, and organises each payer into the right group for the current
                academic year. Confident matches enrol automatically; anything unclear waits in the
                review queue (threshold {Math.round(o.autoEnrollThreshold * 100)}%). You can also add
                or remove people by hand on any group.
              </li>
              <li>
                On each group&apos;s reminder days (Monday &amp; Tuesday by default, fully
                customisable) the system emails active enrolments the Zoom link and the PDF schedule
                from info@studymind.co.uk, and reminds the team to rotate Zoom links on their
                interval. When a subscription lapses, the enrolment expires and the emails stop — a
                re-subscription revives it.
              </li>
            </ol>
          </CardBody>
        </Card>
      </PageBody>
    </>
  )
}
