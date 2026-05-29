// Quick-action "Forward to..." panel on the contact page. The agent picks a
// rule from the dropdown, the panel renders the templated subject + body
// (editable before sending), and the send records an `email_forwarded`
// Interaction on the contact.
//
// CLAUDE.md §27 — Sales Executive+ can send; rule catalogue is admin-managed
// at /settings/forwarding (Manager+).

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

interface Props {
  contactId: string
}

export function ForwardingSection({ contactId }: Props) {
  const router = useRouter()
  const rulesQuery = trpc.forwarding.rules.list.useQuery({ includeArchived: false })
  const [ruleId, setRuleId] = useState<string>('')
  const [notes, setNotes] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  // Optional follow-up task ("assigning"). When the agent forwards a query
  // they often want a CRM owner to take action — flipping this on creates a
  // Task linked to the contact alongside the forward. Two separate
  // mutations: the forward is recorded either way; the task is independently
  // audited via `task.create`.
  const [createTask, setCreateTask] = useState(false)
  const [assigneeId, setAssigneeId] = useState('')
  const [teamId, setTeamId] = useState('')
  const [taskTitle, setTaskTitle] = useState('')
  const [taskDueAt, setTaskDueAt] = useState('')

  const assigneesQuery = trpc.task.assignableUsers.useQuery(
    {},
    { enabled: createTask },
  )
  const teamsQuery = trpc.team.pickList.useQuery(undefined, { enabled: createTask })
  const createTaskMutation = trpc.task.create.useMutation()

  const rules = rulesQuery.data ?? []
  const selectedRule = useMemo(
    () => rules.find((r) => r.id === ruleId),
    [rules, ruleId],
  )

  // Default to the first rule when the list arrives.
  useEffect(() => {
    if (!ruleId && rules.length > 0) {
      setRuleId(rules[0]!.id)
    }
  }, [rules, ruleId])

  const utils = trpc.useUtils()
  const send = trpc.forwarding.send.useMutation()

  // Re-render the templated subject + body whenever the rule or notes change.
  // Result hydrates the editable fields; agents may still edit before send.
  useEffect(() => {
    let cancelled = false
    async function refreshPreview() {
      if (!ruleId) return
      try {
        const preview = await utils.forwarding.preview.fetch({
          contactId,
          ruleId,
          notes,
        })
        if (cancelled) return
        setSubject(preview.subject)
        setBody(preview.body)
      } catch (e) {
        if (cancelled) return
        toast.error(e instanceof Error ? e.message : 'Could not preview')
      }
    }
    void refreshPreview()
    return () => {
      cancelled = true
    }
  }, [ruleId, notes, contactId, utils])

  async function submit() {
    if (!ruleId || !subject.trim() || !body.trim()) {
      toast.error('Pick a rule and check the subject and body before sending.')
      return
    }
    if (createTask && !assigneeId) {
      toast.error('Pick someone to assign the follow-up task to.')
      return
    }
    setBusy(true)
    try {
      const result = await send.mutateAsync({
        contactId,
        ruleId,
        subject: subject.trim(),
        body: body.trim(),
      })
      if (result.status === 'sent') {
        toast.success(`Forwarded — ${selectedRule?.label ?? 'sent'}`)
      } else if (result.status === 'skipped') {
        toast(`Logged but not sent: ${result.detail ?? 'channel skipped'}`)
      } else {
        toast.error(`Send failed: ${result.detail ?? 'unknown error'}`)
      }

      if (createTask && assigneeId) {
        try {
          const title =
            taskTitle.trim() ||
            `Follow up: ${selectedRule?.label ?? 'forwarded query'}`
          await createTaskMutation.mutateAsync({
            title,
            description: notes.trim() || undefined,
            assigneeId,
            teamId: teamId || undefined,
            dueAt: taskDueAt ? new Date(taskDueAt) : undefined,
            contactId,
          })
          toast.success('Follow-up task assigned')
        } catch (e) {
          toast.error(
            e instanceof Error
              ? `Forward sent but task failed: ${e.message}`
              : 'Forward sent but task failed',
          )
        }
      }

      setNotes('')
      setTaskTitle('')
      setTaskDueAt('')
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not forward')
    } finally {
      setBusy(false)
    }
  }

  if (rulesQuery.isLoading) {
    return <p className="text-sm text-neutral-500">Loading rules…</p>
  }
  if (rules.length === 0) {
    return (
      <p className="text-sm text-neutral-600">
        No active forwarding rules. Ask a Manager to add one in Settings → Forwarding.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
        <div>
          <label
            htmlFor="forwarding-rule"
            className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
          >
            Forward to
          </label>
          <Select
            id="forwarding-rule"
            value={ruleId}
            onChange={(e) => setRuleId(e.target.value)}
            className="mt-1"
          >
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="self-end text-[11px] text-neutral-500">
          {selectedRule && (
            <div className="space-y-0.5">
              <div>
                <span className="font-medium text-neutral-700">To:</span>{' '}
                {selectedRule.toAddresses.join(', ')}
              </div>
              {selectedRule.ccAddresses.length > 0 && (
                <div>
                  <span className="font-medium text-neutral-700">Cc:</span>{' '}
                  {selectedRule.ccAddresses.join(', ')}
                </div>
              )}
              {selectedRule.bccAddresses.length > 0 && (
                <div>
                  <span className="font-medium text-neutral-700">Bcc:</span>{' '}
                  {selectedRule.bccAddresses.join(', ')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div>
        <label
          htmlFor="forwarding-notes"
          className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
        >
          Your message (replaces <code>{'{{notes}}'}</code> in the template)
        </label>
        <Textarea
          id="forwarding-notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What do you need the team to look at?"
          className="mt-1"
        />
      </div>

      <div>
        <label
          htmlFor="forwarding-subject"
          className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
        >
          Subject
        </label>
        <Input
          id="forwarding-subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="mt-1"
        />
      </div>

      <div>
        <label
          htmlFor="forwarding-body"
          className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
        >
          Body
        </label>
        <Textarea
          id="forwarding-body"
          rows={10}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="mt-1 font-mono text-sm"
        />
      </div>

      <div className="rounded-lg border border-neutral-200 bg-neutral-50/60 p-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
            checked={createTask}
            onChange={(e) => setCreateTask(e.target.checked)}
          />
          Also assign a follow-up task on this contact
        </label>

        {createTask && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label
                htmlFor="forwarding-assignee"
                className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
              >
                Assign to
              </label>
              <Select
                id="forwarding-assignee"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className="mt-1"
              >
                <option value="">— Pick a user —</option>
                {(assigneesQuery.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name ? `${u.name} (${u.email})` : u.email}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label
                htmlFor="forwarding-team"
                className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
              >
                Scope to team (optional)
              </label>
              <Select
                id="forwarding-team"
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                className="mt-1"
              >
                <option value="">— None —</option>
                {(teamsQuery.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label
                htmlFor="forwarding-task-title"
                className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
              >
                Task title
              </label>
              <Input
                id="forwarding-task-title"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
                placeholder={`Follow up: ${selectedRule?.label ?? 'forwarded query'}`}
                className="mt-1"
              />
            </div>
            <div>
              <label
                htmlFor="forwarding-task-due"
                className="block text-[11px] font-medium uppercase tracking-wide text-neutral-500"
              >
                Due (optional)
              </label>
              <Input
                id="forwarding-task-due"
                type="datetime-local"
                value={taskDueAt}
                onChange={(e) => setTaskDueAt(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          type="button"
          onClick={submit}
          disabled={busy || !ruleId || !subject.trim() || !body.trim()}
        >
          {busy ? 'Sending…' : createTask ? 'Send & assign' : 'Send forward'}
        </Button>
      </div>

      <p className="text-[11px] text-neutral-500">
        The send is recorded on this contact&apos;s timeline with the subject,
        body, recipients, and timestamp. Optionally creates a Task assigned to a
        CRM user so someone owns the follow-up. Rule catalogue is editable in
        Settings → Forwarding.
      </p>
    </div>
  )
}
