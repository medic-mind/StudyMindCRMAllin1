// Cohorts have been folded into Groups. This route redirects to the Groups list
// (each group manages its own term dates + holidays now).

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function CohortDetailRedirect() {
  redirect('/webinars/groups')
}
