// "Classes" are now "Groups" (each group = a subject + level). This route
// redirects to the Groups list.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function ClassesIndexRedirect() {
  redirect('/webinars/groups')
}
