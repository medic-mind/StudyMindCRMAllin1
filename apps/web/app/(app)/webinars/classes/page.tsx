// Classes are managed under their cohort now (no flat "all classes" view).
// This route redirects to the cohort list. Individual class pages still live at
// /webinars/classes/[id].

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function ClassesIndexRedirect() {
  redirect('/webinars/cohorts')
}
