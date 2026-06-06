// Editable name + email for the signed-in user. Replaces the read-only display
// on /account so people can fix their own details without an admin. Email is
// the sign-in identifier; the server enforces uniqueness. CLAUDE.md §20.

'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { trpc } from '@/lib/trpc/client'

interface Props {
  initialName: string | null
  initialEmail: string
}

export function ProfileForm({ initialName, initialEmail }: Props) {
  const router = useRouter()
  const [name, setName] = useState(initialName ?? '')
  const [email, setEmail] = useState(initialEmail)
  const dirty = name.trim() !== (initialName ?? '') || email.trim() !== initialEmail

  const update = trpc.account.updateProfile.useMutation({
    onSuccess: () => {
      toast.success('Profile updated')
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not save your changes'),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        update.mutate({ name: name.trim() || undefined, email: email.trim() })
      }}
      className="space-y-4"
    >
      <Field
        label="Name"
        htmlFor="profile-name"
        hint="Shown across the CRM and on messages you send."
      >
        <Input
          id="profile-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          autoComplete="name"
        />
      </Field>
      <Field label="Email" htmlFor="profile-email" hint="The address you sign in with.">
        <Input
          id="profile-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@studymind.co.uk"
          autoComplete="email"
          required
        />
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!dirty || update.isPending}>
          {update.isPending ? 'Saving…' : 'Save changes'}
        </Button>
        {dirty && !update.isPending ? (
          <button
            type="button"
            onClick={() => {
              setName(initialName ?? '')
              setEmail(initialEmail)
            }}
            className="text-sm text-neutral-500 hover:text-neutral-800"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  )
}
