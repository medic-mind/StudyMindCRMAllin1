// The audit log moved out of Settings to its own top-level nav section
// (`/audit`). Keep this route as a redirect so any existing deep link still
// resolves (repo convention — old routes redirect, never 404).

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function SettingsAuditRedirect() {
  redirect('/audit')
}
