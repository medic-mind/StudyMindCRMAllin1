// Manage the webinar subject + level/type catalogues. Adding here makes the
// option appear in the "New class" dropdowns and teaches the Stripe matcher to
// recognise it (via the label + aliases). CLAUDE.md §47.

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { getCurrentUser } from '@/lib/auth/server'
import { createServerCaller } from '@/lib/trpc/server'

import { CatalogueManager } from './CatalogueManager'

export const dynamic = 'force-dynamic'

const MANAGE = new Set(['ceo', 'senior_manager', 'manager'])

export default async function SubjectsPage() {
  const me = await getCurrentUser()
  const caller = await createServerCaller()
  const [subjects, levels] = await Promise.all([
    caller.webinar.subject.list({ includeArchived: true }),
    caller.webinar.level.list({ includeArchived: true }),
  ])
  const canManage = MANAGE.has(me?.role ?? '')

  return (
    <>
      <PageHeader
        title="Subjects & levels"
        subtitle="The options offered in the New-class workflow. Add subjects (Biology, Further Maths…) and levels/types (GCSE, A-Level, UCAT, GAMSAT, 11+…)."
        breadcrumbs={[
          { label: 'Webinars', href: '/webinars' },
          { label: 'Subjects & levels', href: '/webinars/subjects' },
        ]}
      />
      <PageBody>
        <div className="grid gap-5 lg:grid-cols-2">
          <CatalogueManager
            kind="subject"
            title="Subjects"
            hint="The subject taught in a class (Biology, Chemistry, …)."
            initial={subjects}
            canManage={canManage}
          />
          <CatalogueManager
            kind="level"
            title="Levels & types"
            hint="The level or exam/type (GCSE, A-Level, UCAT, GAMSAT, 11+, …)."
            initial={levels}
            canManage={canManage}
          />
        </div>
      </PageBody>
    </>
  )
}
