// The complaints report moved under the Complaints section (2026-07). This
// route redirects so old links / bookmarks keep working.

import { redirect } from 'next/navigation'

export default function LegacyComplaintsReportRedirect() {
  redirect('/complaints/reports')
}
