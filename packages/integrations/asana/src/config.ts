// Asana project allowlist. CLAUDE.md §13: scoped to a defined set of projects,
// never the whole workspace. Production set via ASANA_ALLOWED_PROJECTS=gid1,gid2.

export function getAllowedProjects(): readonly string[] {
  const raw = process.env['ASANA_ALLOWED_PROJECTS']
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function isAllowedProject(projectGid: string): boolean {
  const list = getAllowedProjects()
  if (list.length === 0) return false
  return list.includes(projectGid)
}
