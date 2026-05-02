// New contact page. The form itself is a client component island.

import { NewContactForm } from './form'

export default function NewContactPage() {
  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-semibold tracking-tight">New contact</h1>
      <p className="mt-1 text-sm text-neutral-600">
        Add a new parent, student, tutor, or LA caseworker to the CRM.
      </p>
      <div className="mt-6">
        <NewContactForm />
      </div>
    </div>
  )
}
