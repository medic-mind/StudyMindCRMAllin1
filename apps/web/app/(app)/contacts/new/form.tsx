'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { useRouter } from 'next/navigation'
import { useForm } from 'react-hook-form'
import { toast } from 'sonner'

import { ContactCreateInput, type ContactCreateInput as ContactCreateInputT } from '@studymind/core/contact'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

import { trpc } from '@/lib/trpc/client'

export function NewContactForm() {
  const router = useRouter()
  const create = trpc.contact.create.useMutation({
    onSuccess: ({ id }) => {
      toast.success('Contact created')
      router.push(`/contacts/${id}`)
    },
    onError: (err) => {
      toast.error(err.message ?? 'Could not create contact')
    },
  })

  const form = useForm<ContactCreateInputT>({
    resolver: zodResolver(ContactCreateInput),
    defaultValues: { kind: 'parent' },
  })
  const { register, handleSubmit, formState } = form

  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit((values) => {
        // Strip empty optional strings — Zod coerces undefined to undefined.
        const cleaned: ContactCreateInputT = {
          kind: values.kind,
          firstName: values.firstName?.trim() || undefined,
          lastName: values.lastName?.trim() || undefined,
          email: values.email?.trim() || undefined,
          phoneE164: values.phoneE164?.trim() || undefined,
          notes: values.notes?.trim() || undefined,
        }
        create.mutate(cleaned)
      })}
    >
      <div className="space-y-1.5">
        <Label htmlFor="kind">Role</Label>
        <Select id="kind" {...register('kind')}>
          <option value="parent">Parent</option>
          <option value="student">Student</option>
          <option value="tutor">Tutor</option>
          <option value="la_caseworker">LA caseworker</option>
          <option value="other">Other</option>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="firstName">First name</Label>
          <Input id="firstName" {...register('firstName')} />
          {formState.errors.firstName && (
            <p className="text-xs text-red-600">{formState.errors.firstName.message}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lastName">Last name</Label>
          <Input id="lastName" {...register('lastName')} />
          {formState.errors.lastName && (
            <p className="text-xs text-red-600">{formState.errors.lastName.message}</p>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" {...register('email')} />
        {formState.errors.email && (
          <p className="text-xs text-red-600">{formState.errors.email.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="phoneE164">Phone (E.164, e.g. +447700900123)</Label>
        <Input id="phoneE164" {...register('phoneE164')} />
        {formState.errors.phoneE164 && (
          <p className="text-xs text-red-600">{formState.errors.phoneE164.message}</p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="notes">Notes</Label>
        <Textarea id="notes" {...register('notes')} />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create contact'}
        </Button>
      </div>
    </form>
  )
}
