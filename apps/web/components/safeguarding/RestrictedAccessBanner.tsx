// Banner shown on Contact detail when a contact is restricted_access.
// CLAUDE.md §42.3 — non-DSL users see only the banner, never the timeline.

export function RestrictedAccessBanner({
  assignedDslName,
}: {
  assignedDslName?: string | null
}) {
  return (
    <div
      role="alert"
      className="mt-4 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-900"
    >
      <h2 className="font-semibold">Restricted contact</h2>
      <p className="mt-1">
        This contact is currently at <strong>restricted_access</strong>. Notes,
        timeline, and outbound replies are hidden from non-DSL users. If you
        need to act on this family, contact the assigned DSL
        {assignedDslName ? ` (${assignedDslName})` : ''}.
      </p>
    </div>
  )
}
