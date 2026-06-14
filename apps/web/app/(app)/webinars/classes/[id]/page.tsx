// A class is now a "group". This route redirects to the group workspace, which
// is the single home for its weekly classes, Zoom link, template, settings and
// students.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function ClassDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  redirect(`/webinars/groups/${id}`)
}
