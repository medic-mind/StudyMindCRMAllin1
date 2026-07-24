// A single complaint's workspace: the customer (CRM contact or a manual person),
// the full status/severity/assignee controls, the message thread (mirrored to the
// customer's CRM timeline + the Slack #complaintcallsummaries thread), and the
// whole lifecycle. RSC shell → the shared ComplaintDetailPanel. CLAUDE.md §26.

import { notFound } from 'next/navigation'

import { ComplaintDetailPanel } from '@/components/complaints/ComplaintDetailPanel'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

export default async function ComplaintDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const caller = await createServerCaller()

  let complaint: Awaited<ReturnType<typeof caller.complaint.get>>
  try {
    complaint = await caller.complaint.get({ id })
  } catch {
    notFound()
  }

  return (
    <>
      <PageHeader
        title={complaint.title}
        subtitle={`Complaint · ${complaint.customerName}`}
        breadcrumbs={[
          { label: 'Complaints', href: '/complaints' },
          { label: complaint.title, href: `/complaints/${id}` },
        ]}
      />
      <PageBody>
        <Card className="mx-auto max-w-3xl p-5">
          <ComplaintDetailPanel complaintId={id} />
        </Card>
      </PageBody>
    </>
  )
}
