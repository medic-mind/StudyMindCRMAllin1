import { redirect } from 'next/navigation'

import { getCurrentUser } from '@/lib/auth/server'

// Root '/' is a routing shim. The (app) layout has already guarded auth, so
// if we reach this page the user is signed in. Send them to the working
// surface most likely to be useful: their inbox.
//
// Dashboard work is in flight in a parallel slice and will land at /dashboard;
// once that page exists, change this redirect to '/dashboard'.
export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const me = await getCurrentUser()
  if (!me) redirect('/sign-in')
  redirect('/inbox')
}
