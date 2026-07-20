// Quick jumps to the sister-app surfaces, shown in the top bar. Open in a new
// tab. Configurable via env so a self-hosted install can re-point them without
// a code change (CLAUDE.md §37).

export interface ExternalAppLink {
  /** Compact label for the top bar. */
  label: string
  /** Full name for the tooltip/aria-label. */
  title: string
  href: string
}

export const EXTERNAL_APP_LINKS: ExternalAppLink[] = [
  {
    label: 'Portal',
    title: 'Main Portal',
    href: process.env['NEXT_PUBLIC_MAIN_PORTAL_URL'] ?? 'https://portal.studymind.co.uk',
  },
  {
    label: 'Invoices',
    title: 'Invoice Site',
    href: process.env['NEXT_PUBLIC_INVOICE_SITE_URL'] ?? 'https://b2b.studymind.co.uk',
  },
  {
    label: 'HR',
    title: 'HR System',
    href: process.env['NEXT_PUBLIC_HR_SITE_URL'] ?? 'https://hr.studymind.co.uk',
  },
  {
    label: 'Trengo',
    title: 'Trengo inbox',
    href: process.env['NEXT_PUBLIC_TRENGO_URL'] ?? 'https://app.trengo.com',
  },
]
