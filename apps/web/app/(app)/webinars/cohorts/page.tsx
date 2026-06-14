// Cohorts have been folded into Groups (each group = a subject + level, with its
// term dates + holidays managed inside it). This route now redirects to Groups.

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function CohortsIndexRedirect() {
  redirect('/webinars/groups')
}
