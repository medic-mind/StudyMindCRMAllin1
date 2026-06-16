// The call-summary send wizard — shared by the contact page and the board
// card modal so both surfaces behave identically. It opens with a fork:
//
//   Step 0 — "Who's sending this summary?"
//            • "I'll send it now"  → the full self-send flow below.
//            • "Hand to a VA"      → write the summary, post it to Slack in
//              the VA-team format, and open a task for the VA team to action
//              it on the CRM. A clean hand-off — no customer message is sent.
//
// Self-send flow:
//   Step 1 — "Send an email?"  Full Gmail compose (send-from picker, To/Cc/Bcc
//            overrides, subject), templates / AI draft, attach PDFs from the
//            document library (info packs, brochures), contact documents,
//            invoices, or device uploads.
//   Step 2 — "Send a text or WhatsApp?"  Pick WhatsApp or SMS and the sender
//            line. WhatsApp surfaces the agent's approved Trengo templates
//            just as they would on Trengo (a real /wa_sessions send, valid
//            outside the 24-hour window). No PDF picker here — the approved
//            templates already carry the pack links.
//   Step 3 — Internal note + optional Slack post + optional follow-up task
//            (person or whole team; never seen by the customer).
//
// Everything sends in ONE audited fan-out; each channel stays best-effort and
// independent. CLAUDE.md §10, §11, §12, §26.

'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { trpc } from '@/lib/trpc/client'

import { missingWaParams, parseWaTemplateSegments, renderWaTemplate } from './wa-template'

type Outcome = 'answered' | 'voicemail' | 'no_answer'
type SendPath = 'self' | 'va'
type Step = 'who' | 'email' | 'text' | 'internal' | 'va'

/** Friendly label for a sent channel, for the Slack "already sent (…)" banner. */
const CHANNEL_LABEL: Record<string, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  trengo: 'Message',
}

/** Split a comma/semicolon/space-separated address list into trimmed emails. */
function splitEmails(raw: string): string[] {
  return raw
    .split(/[,;\s]+/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

type AttachmentKind = 'contactDocument' | 'uploadedInvoice' | 'callSummaryTemplatePdf' | 'infoPack'

interface AttachmentChoice {
  kind: AttachmentKind
  id: string
  label: string
  hint?: string
}

export interface CallSummaryWizardProps {
  /** Which tRPC namespace records + sends the summary. */
  mode: 'contact' | 'card'
  contactId: string
  /** Required in card mode. */
  cardId?: string
  contactName: string
}

/** Substitute {{first_name}} / {{name}} in a saved template body. */
function applyNamePlaceholders(body: string, name: string): string {
  const firstName = name.split(/\s+/)[0] ?? ''
  return body.replace(/\{\{\s*first_name\s*\}\}/gi, firstName).replace(/\{\{\s*name\s*\}\}/gi, name)
}

/** Read a File as a base64 string (no data-URL prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.readAsDataURL(file)
  })
}

function describeChannelResults(
  results: Partial<Record<string, { status: string; detail?: string }>>,
): string {
  const parts: string[] = []
  for (const [k, r] of Object.entries(results)) {
    if (!r) continue
    if (r.status === 'sent') parts.push(`${k} ✓`)
    else if (r.status === 'skipped') parts.push(`${k} skipped${r.detail ? ` (${r.detail})` : ''}`)
    else parts.push(`${k} failed${r.detail ? ` (${r.detail})` : ''}`)
  }
  return parts.join(' · ')
}

export function CallSummaryWizard({
  mode,
  contactId,
  cardId,
  contactName,
}: CallSummaryWizardProps) {
  const router = useRouter()

  // ── Wizard position + shared facts ────────────────────────────────
  const [step, setStep] = useState<Step>('who')
  const [sendPath, setSendPath] = useState<SendPath | null>(null)
  const [outcome, setOutcome] = useState<Outcome>('answered')

  // ── Step 1: email ──────────────────────────────────────────────────
  const [emailWanted, setEmailWanted] = useState<boolean | null>(null)
  const [emailBody, setEmailBody] = useState('')
  const [emailSubject, setEmailSubject] = useState('')
  // Full-Gmail compose extras.
  const [emailFrom, setEmailFrom] = useState('')
  const [emailTo, setEmailTo] = useState('')
  const [emailCc, setEmailCc] = useState('')
  const [emailBcc, setEmailBcc] = useState('')
  const [showCcBcc, setShowCcBcc] = useState(false)
  const [activeTemplateId, setActiveTemplateId] = useState<string | null>(null)
  const [pickedAttachments, setPickedAttachments] = useState<
    Array<{ kind: AttachmentKind; id: string }>
  >([])
  const [uploadedFiles, setUploadedFiles] = useState<
    Array<{ filename: string; contentType: string; dataBase64: string; size: number }>
  >([])
  const [drafting, setDrafting] = useState(false)

  // ── Step 2: text / WhatsApp ───────────────────────────────────────
  const [textWanted, setTextWanted] = useState<boolean | null>(null)
  const [textChannel, setTextChannel] = useState<'whatsapp' | 'sms'>('whatsapp')
  const [waMode, setWaMode] = useState<'template' | 'custom'>('template')
  const [waTemplateId, setWaTemplateId] = useState<number | null>(null)
  const [waParams, setWaParams] = useState<Record<string, string>>({})
  const [textBody, setTextBody] = useState('')
  // Trengo sender line (which WhatsApp/SMS number to send from) — only used
  // when STARTING a new conversation. Empty = workspace default.
  const [trengoChannelId, setTrengoChannelId] = useState('')

  // ── VA hand-off path ──────────────────────────────────────────────
  const [vaBody, setVaBody] = useState('')
  const [vaTaskTarget, setVaTaskTarget] = useState('')
  const [vaDueAt, setVaDueAt] = useState('')
  const [draftingVa, setDraftingVa] = useState(false)

  // ── Step 3: internal note ─────────────────────────────────────────
  const [summaryId, setSummaryId] = useState<string | null>(null)
  const [sentSomething, setSentSomething] = useState(false)
  // The channels the customer summary actually went out on — drives the
  // "already sent (Email, WhatsApp)" Slack banner.
  const [sentChannels, setSentChannels] = useState<string[]>([])
  const [internalNote, setInternalNote] = useState('')
  const [createTask, setCreateTask] = useState(false)
  const [taskTitle, setTaskTitle] = useState('')
  const [taskAssigneeId, setTaskAssigneeId] = useState('')
  const [taskDueAt, setTaskDueAt] = useState('')
  const [draftingNote, setDraftingNote] = useState(false)

  const [busy, setBusy] = useState(false)

  // Both namespaces' hooks are mounted unconditionally (rules of hooks); the
  // mode picks which pair actually fires.
  const addContact = trpc.contact.callSummary.add.useMutation()
  const addCard = trpc.card.callSummary.add.useMutation()
  const sendContact = trpc.contact.callSummary.send.useMutation()
  const sendCard = trpc.card.callSummary.send.useMutation()
  const logInternal = trpc.contact.callSummary.logInternal.useMutation()
  // ADR 0039 amendment: every summary is announced to #callsummaries.
  const announceToSlack = trpc.contact.callSummary.announceToSlack.useMutation()
  const taskCreate = trpc.task.create.useMutation()
  const utils = trpc.useUtils()

  const templatesQuery = trpc.callSummaryTemplate.pickList.useQuery()
  const templates = templatesQuery.data ?? []
  const activeTemplate = templates.find((t) => t.id === activeTemplateId) ?? null

  const quickRepliesQuery = trpc.quickReply.list.useQuery(undefined, {
    staleTime: 5 * 60_000,
    retry: false,
  })
  const quickReplies = quickRepliesQuery.data ?? []

  const vaQuery = trpc.task.assignableUsers.useQuery({})
  const assignableUsers = vaQuery.data ?? []
  // A follow-up task can be for one person OR a whole team (VA team, sales
  // pod, anything in Settings → Teams).
  const teamsQuery = trpc.team.pickList.useQuery()
  const teams = teamsQuery.data ?? []
  // A team that looks like the VA team — preselected for the hand-off task.
  const vaTeam = useMemo(
    () => teams.find((t) => /\bva\b|virtual assistant/i.test(t.name)) ?? null,
    [teams],
  )

  // Full-Gmail "From" picker — the agent's connected send-from addresses.
  const mailboxesQuery = trpc.contact.callSummary.mailboxes.useQuery(undefined, {
    enabled: step === 'email',
    staleTime: 5 * 60_000,
    retry: false,
  })
  const mailboxes = mailboxesQuery.data ?? []
  useEffect(() => {
    if (!emailFrom && mailboxes.length > 0) {
      setEmailFrom(mailboxes.find((m) => m.isDefault)?.address ?? mailboxes[0]!.address)
    }
  }, [mailboxes, emailFrom])

  // Trengo sender lines (WhatsApp/SMS numbers) for the "send from" picker.
  const trengoChannelsQuery = trpc.interaction.trengo.channels.useQuery(undefined, {
    enabled: step === 'text',
    staleTime: 5 * 60_000,
    retry: false,
  })
  const trengoChannels = trengoChannelsQuery.data?.available
    ? trengoChannelsQuery.data.channels
    : []
  const trengoLinesForChannel = trengoChannels.filter((c) => c.kind === textChannel)

  // Attachment sources for the EMAIL step. Info packs come from the shared
  // document library (Settings → Documents); the rest are per-contact.
  const infoPacksQuery = trpc.infoPack.pickList.useQuery()
  const documentsQuery = trpc.contact.documents.list.useQuery(
    { contactId },
    { enabled: Boolean(contactId) },
  )
  const invoicesQuery = trpc.uploadedInvoice.list.useQuery(
    { contactId, includeArchived: false },
    { enabled: Boolean(contactId) },
  )
  const attachTemplatesQuery = trpc.callSummaryTemplate.list.useQuery({ includeArchived: false })

  const attachmentChoices: AttachmentChoice[] = [
    ...(infoPacksQuery.data ?? []).map((p) => ({
      kind: 'infoPack' as const,
      id: p.id,
      label: p.name,
      hint: p.description ?? 'Info pack / brochure',
    })),
    ...(documentsQuery.data ?? []).map((d) => ({
      kind: 'contactDocument' as const,
      id: d.id,
      label: d.fileName,
      hint: 'Contact document',
    })),
    ...(invoicesQuery.data ?? []).map((i) => ({
      kind: 'uploadedInvoice' as const,
      id: i.id,
      label: i.fileName,
      hint: i.invoiceNumber ? `Invoice #${i.invoiceNumber}` : 'Uploaded invoice',
    })),
    ...(attachTemplatesQuery.data ?? [])
      .filter((t) => t.hasPdf)
      .map((t) => ({
        kind: 'callSummaryTemplatePdf' as const,
        id: t.id,
        label: t.pdfFileName ?? t.name,
        hint: `Template · ${t.name}`,
      })),
  ]

  // The agent's approved Trengo WhatsApp templates — fetched lazily when the
  // text step opens so the picker feels instant once they get there.
  const waTemplatesQuery = trpc.contact.callSummary.waTemplates.useQuery(undefined, {
    enabled: step === 'text',
    staleTime: 5 * 60_000,
    retry: false,
  })
  const waTemplates = waTemplatesQuery.data?.available ? waTemplatesQuery.data.templates : []
  const waTemplate = waTemplates.find((t) => t.id === waTemplateId) ?? null
  const waRendered = waTemplate ? renderWaTemplate(waTemplate.body, waParams) : ''

  // Default the first {{1}} param to the contact's first name when a template
  // is picked — the most common personalisation, still editable.
  useEffect(() => {
    if (!waTemplate) return
    setWaParams((prev) => {
      if (waTemplate.params.length === 0) return prev
      const first = waTemplate.params[0]!
      if (prev[first] !== undefined) return prev
      return { ...prev, [first]: contactName.split(/\s+/)[0] ?? '' }
    })
  }, [waTemplate, contactName])

  function isPicked(choice: AttachmentChoice): boolean {
    return pickedAttachments.some((p) => p.kind === choice.kind && p.id === choice.id)
  }
  function toggleAttachment(choice: AttachmentChoice, next: boolean) {
    setPickedAttachments((prev) => {
      const without = prev.filter((p) => !(p.kind === choice.kind && p.id === choice.id))
      return next ? [...without, { kind: choice.kind, id: choice.id }] : without
    })
  }

  async function onPickFiles(files: FileList | null) {
    if (!files || files.length === 0) return
    const next: Array<{ filename: string; contentType: string; dataBase64: string; size: number }> =
      []
    for (const file of Array.from(files)) {
      if (file.size > 8 * 1024 * 1024) {
        toast.error(`"${file.name}" is over the 8 MB limit.`)
        continue
      }
      const dataBase64 = await fileToBase64(file)
      next.push({
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        dataBase64,
        size: file.size,
      })
    }
    if (next.length > 0) setUploadedFiles((prev) => [...prev, ...next].slice(0, 10))
  }
  function removeUpload(idx: number) {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  function insertQuickReply(id: string, into: 'email' | 'text') {
    const qr = quickReplies.find((q) => q.id === id)
    if (!qr) return
    const text = applyNamePlaceholders(qr.body, contactName)
    if (into === 'email') {
      setEmailBody((prev) => (prev.trim() ? `${prev.trim()}\n\n${text}` : text))
    } else {
      setTextBody((prev) => (prev.trim() ? `${prev.trim()}\n\n${text}` : text))
    }
  }

  async function draftFromCall() {
    setDrafting(true)
    const hadBase = emailBody.trim().length > 0
    try {
      // Send the current compose text (e.g. a clicked template) so the AI
      // ENHANCES it with the call's facts rather than replacing it.
      const result =
        mode === 'card' && cardId
          ? await utils.card.callSummary.draftFromCall.fetch({
              cardId,
              baseText: emailBody.trim() || undefined,
            })
          : await utils.contact.callSummary.draftFromCall.fetch({
              contactId,
              baseText: emailBody.trim() || undefined,
            })
      setEmailBody(result.text)
      if (result.outcomeHint) setOutcome(result.outcomeHint as Outcome)
      if (!result.aiUsed) {
        toast.warning(
          'AI is unavailable right now — your text was left unchanged. Ask an admin to check the AI provider key / budget (details are in the server logs).',
        )
      } else if (result.hadTranscript) {
        toast.success(
          hadBase
            ? 'AI enhanced your draft with the call — review before sending.'
            : 'AI draft from the call ready — edit before sending.',
        )
      } else {
        toast.info(
          'No transcript on the latest call (AI Assist may be off for that line) — AI drafted from the contact details instead; fill in the blanks.',
        )
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not draft from call')
    } finally {
      setDrafting(false)
    }
  }

  async function suggestInternalNote() {
    setDraftingNote(true)
    try {
      const r = await utils.contact.callSummary.draftInternalNote.fetch({
        contactId,
        customerSummary: emailBody.trim() || textBody.trim() || undefined,
      })
      setInternalNote((prev) => (prev.trim() ? `${prev.trim()}\n\n${r.text}` : r.text))
      toast.success('Suggested next steps added — edit as needed.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not suggest next steps')
    } finally {
      setDraftingNote(false)
    }
  }

  // AI-draft the VA hand-off summary from the latest call (mirrors the email
  // draft but writes into the hand-off body).
  async function draftVaSummary() {
    setDraftingVa(true)
    const hadBase = vaBody.trim().length > 0
    try {
      const result =
        mode === 'card' && cardId
          ? await utils.card.callSummary.draftFromCall.fetch({
              cardId,
              baseText: vaBody.trim() || undefined,
            })
          : await utils.contact.callSummary.draftFromCall.fetch({
              contactId,
              baseText: vaBody.trim() || undefined,
            })
      setVaBody(result.text)
      if (result.outcomeHint) setOutcome(result.outcomeHint as Outcome)
      if (!result.aiUsed) {
        toast.warning('AI is unavailable right now — your text was left unchanged.')
      } else {
        toast.success(hadBase ? 'AI enhanced your summary.' : 'AI summary ready — review it.')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not draft summary')
    } finally {
      setDraftingVa(false)
    }
  }

  // Resolve a `team:<id>` / `user:<id>` target to a human label for the Slack
  // "assigned to" line and the follow-up bullet.
  function assigneeLabel(target: string): string | null {
    if (!target) return null
    if (target.startsWith('team:')) {
      const id = target.slice('team:'.length)
      const t = teams.find((x) => x.id === id)
      return t ? `${t.name} (team)` : 'Team'
    }
    const id = target.replace(/^user:/, '')
    const u = assignableUsers.find((x) => x.id === id)
    return u ? (u.name ?? u.email) : null
  }

  // COMPULSORY post to #callsummaries (ADR 0039 amendment). Best-effort: a
  // Slack failure surfaces a toast but never blocks — the CRM record is saved.
  async function announceCallSummary(args: {
    summaryInteractionId?: string | null
    disposition: 'sent_to_customer' | 'va_handoff' | 'logged'
    body: string
    sentChannels?: string[]
    followUps?: Array<{ title: string; dueAt?: string | null; assignee?: string | null }>
    handoffAssignee?: string | null
  }) {
    try {
      const res = await announceToSlack.mutateAsync({
        contactId,
        summaryInteractionId: args.summaryInteractionId ?? summaryId ?? undefined,
        disposition: args.disposition,
        body: args.body.slice(0, 8000),
        outcome,
        ...(args.sentChannels && args.sentChannels.length > 0
          ? { sentChannels: args.sentChannels }
          : {}),
        ...(args.followUps && args.followUps.length > 0 ? { followUps: args.followUps } : {}),
        ...(args.handoffAssignee ? { handoffAssignee: args.handoffAssignee } : {}),
      })
      if (res.slack?.status === 'sent') toast('Posted to #callsummaries ✓')
      else if (res.slack?.status === 'skipped')
        toast.warning(
          `Not posted to Slack — ${res.slack.detail ?? 'no channel configured'}. Ask an admin to set the call-summaries channel in Settings → Slack channels.`,
        )
      else if (res.slack?.status === 'failed')
        toast.error(`Slack post failed${res.slack.detail ? ` (${res.slack.detail})` : ''}`)
    } catch (e) {
      toast.error(e instanceof Error ? `Slack: ${e.message}` : 'Could not post to Slack')
    }
  }

  function resetAll() {
    setStep('who')
    setSendPath(null)
    setOutcome('answered')
    setEmailWanted(null)
    setEmailBody('')
    setEmailSubject('')
    setEmailFrom('')
    setEmailTo('')
    setEmailCc('')
    setEmailBcc('')
    setShowCcBcc(false)
    setActiveTemplateId(null)
    setPickedAttachments([])
    setUploadedFiles([])
    setTextWanted(null)
    setTextChannel('whatsapp')
    setWaMode('template')
    setWaTemplateId(null)
    setWaParams({})
    setTextBody('')
    setTrengoChannelId('')
    setVaBody('')
    setVaTaskTarget('')
    setVaDueAt('')
    setSummaryId(null)
    setSentSomething(false)
    setSentChannels([])
    setInternalNote('')
    setCreateTask(false)
    setTaskTitle('')
    setTaskAssigneeId('')
    setTaskDueAt('')
  }

  // ── Step 0 — who's sending? ───────────────────────────────────────
  function choosePath(path: SendPath) {
    setSendPath(path)
    setStep(path === 'self' ? 'email' : 'va')
  }

  // VA hand-off: record the summary, open a task for the VA team to action it
  // on the CRM, and post it to #callsummaries making it AWFULLY CLEAR the VA
  // team must send it and clear it. No customer message is sent on this path.
  async function submitVaHandoff() {
    if (!vaBody.trim()) {
      toast.error('Write the call summary first.')
      return
    }
    // The dropdown shows the VA team as a preselected default; honour it even
    // when the agent never opens the menu.
    const effectiveTarget = vaTaskTarget || (vaTeam ? `team:${vaTeam.id}` : '')
    if (!effectiveTarget) {
      toast.error('Pick who should action this (a person or the VA team).')
      return
    }
    setBusy(true)
    try {
      const body = mode === 'card' ? vaBody.trim().slice(0, 4000) : vaBody.trim().slice(0, 8000)
      const created =
        mode === 'card' && cardId
          ? await addCard.mutateAsync({ cardId, body, outcome })
          : await addContact.mutateAsync({ contactId, body, outcome })
      setSummaryId(created.id)

      // Open the VA-team task to send + clear the summary on the CRM.
      const isTeam = effectiveTarget.startsWith('team:')
      const assignee = assigneeLabel(effectiveTarget)
      await taskCreate.mutateAsync({
        title: `Send call summary: ${contactName}`,
        description: `${vaBody.trim()}\n\n— Please send this to the customer and clear the call summary on the CRM.`,
        contactId,
        assigneeId: isTeam ? undefined : effectiveTarget.replace(/^user:/, ''),
        teamId: isTeam ? effectiveTarget.slice('team:'.length) : undefined,
        dueAt: vaDueAt ? new Date(vaDueAt) : undefined,
      })

      // COMPULSORY: post to #callsummaries — awfully clear it needs VA action.
      await announceCallSummary({
        summaryInteractionId: created.id,
        disposition: 'va_handoff',
        body: vaBody.trim(),
        handoffAssignee: assignee,
        followUps: [
          { title: `Send call summary: ${contactName}`, dueAt: vaDueAt || null, assignee },
        ],
      })

      toast.success('Handed to the VA team — task created')
      resetAll()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not hand off')
    } finally {
      setBusy(false)
    }
  }

  // Step 1 → step 2. Prefill the text body from the email so the agent can
  // shorten it rather than retype it.
  function continueToText() {
    if (emailWanted === null) {
      toast.error('Choose Yes or No first.')
      return
    }
    if (emailWanted && !emailBody.trim()) {
      toast.error('Write the email first (or choose No).')
      return
    }
    if (!textBody.trim() && emailBody.trim()) setTextBody(emailBody.trim())
    setStep('text')
  }

  /** The text actually going out on the text channel right now. */
  function effectiveTextBody(): string {
    if (textChannel === 'whatsapp' && waMode === 'template') return waRendered
    return textBody.trim()
  }

  // End of step 2 — save the call_summary Interaction and fan out to every
  // chosen channel in one audited send, then advance to the internal note.
  async function sendNow() {
    if (textWanted === null) {
      toast.error('Choose Yes or No first.')
      return
    }
    const sendEmailChannel = emailWanted === true
    const sendText = textWanted === true
    const usingWaTemplate = sendText && textChannel === 'whatsapp' && waMode === 'template'

    if (sendText && usingWaTemplate && !waTemplate) {
      toast.error('Pick a WhatsApp template (or switch to free text).')
      return
    }
    if (sendText && usingWaTemplate && waTemplate) {
      const missing = missingWaParams(waTemplate.params, waParams)
      if (missing.length > 0) {
        toast.error(
          `Fill in the blank${missing.length > 1 ? 's' : ''} in the message first (${missing.join(', ')}).`,
        )
        return
      }
    }
    if (sendText && !usingWaTemplate && !textBody.trim()) {
      toast.error('Write the message first (or choose No).')
      return
    }

    const textOut = sendText ? effectiveTextBody() : ''
    // The canonical customer-facing record: the email wins when both exist.
    const summaryBody = (sendEmailChannel ? emailBody.trim() : '') || textOut
    setBusy(true)
    try {
      let createdId: string | null = null
      if (sendEmailChannel || sendText) {
        const body = mode === 'card' ? summaryBody.slice(0, 4000) : summaryBody.slice(0, 8000)
        const created =
          mode === 'card' && cardId
            ? await addCard.mutateAsync({ cardId, body, outcome })
            : await addContact.mutateAsync({ contactId, body, outcome })
        createdId = created.id
        setSummaryId(created.id)

        const channels = {
          email: sendEmailChannel,
          whatsapp: sendText && textChannel === 'whatsapp',
          sms: sendText && textChannel === 'sms',
        }
        const channelBodies = {
          ...(sendEmailChannel ? { email: emailBody.trim() } : {}),
          ...(channels.whatsapp ? { whatsapp: textOut } : {}),
          ...(channels.sms ? { sms: textOut } : {}),
        }
        const ccList = sendEmailChannel ? splitEmails(emailCc) : []
        const bccList = sendEmailChannel ? splitEmails(emailBcc) : []
        const toList = sendEmailChannel ? splitEmails(emailTo) : []
        const payload = {
          summaryInteractionId: created.id,
          channels,
          channelBodies,
          ...(sendEmailChannel && emailSubject.trim() ? { emailSubject: emailSubject.trim() } : {}),
          ...(toList.length > 0 ? { emailTo: toList } : {}),
          ...(ccList.length > 0 ? { emailCc: ccList } : {}),
          ...(bccList.length > 0 ? { emailBcc: bccList } : {}),
          ...(sendEmailChannel && emailFrom ? { emailFromAddress: emailFrom } : {}),
          ...(sendText && trengoChannelId ? { trengoChannelId: Number(trengoChannelId) } : {}),
          ...(usingWaTemplate && waTemplate
            ? {
                whatsappTemplate: {
                  templateId: waTemplate.id,
                  templateTitle: waTemplate.title,
                  params: waTemplate.params.map((key) => ({
                    key,
                    value: waParams[key] ?? '',
                  })),
                },
              }
            : {}),
          // PDFs ride the email (and free-text Trengo) channels only; the
          // template path never carries them (the packs are already linked).
          emailAttachments:
            sendEmailChannel && pickedAttachments.length > 0 ? pickedAttachments : undefined,
          uploadedAttachments:
            sendEmailChannel && uploadedFiles.length > 0
              ? uploadedFiles.map((f) => ({
                  filename: f.filename,
                  contentType: f.contentType,
                  dataBase64: f.dataBase64,
                }))
              : undefined,
        }
        const results =
          mode === 'card' && cardId
            ? await sendCard.mutateAsync(payload)
            : await sendContact.mutateAsync(payload)
        const resultMap = (results ?? {}) as Partial<
          Record<string, { status: string; detail?: string }>
        >
        const described = describeChannelResults(resultMap)
        toast(described || 'Summary saved')
        setSentSomething(true)
        // Capture the channels that actually reached the customer for the
        // compulsory Slack "already sent (…)" banner.
        setSentChannels(
          Object.entries(resultMap)
            .filter(([, r]) => r?.status === 'sent')
            .map(([k]) => CHANNEL_LABEL[k] ?? k),
        )
      }

      // Prefill the internal note with what went to the customer so the agent
      // only appends next steps / VA instructions.
      setInternalNote((prev) => prev.trim() || summaryBody)
      setTaskTitle(`Follow up: ${contactName}`)
      setStep('internal')
      if (createdId) router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send')
    } finally {
      setBusy(false)
    }
  }

  // Step 3 — log the internal note, open any follow-up task, then COMPULSORILY
  // announce the summary to #callsummaries (the Slack post is no longer
  // optional — ADR 0039 amendment).
  async function submitInternal() {
    if (!internalNote.trim()) {
      toast.error('Add an internal note first.')
      return
    }
    if (createTask && !taskAssigneeId) {
      toast.error('Pick who the task is for.')
      return
    }
    setBusy(true)
    try {
      await logInternal.mutateAsync({
        contactId,
        note: internalNote,
        // Slack is handled by the compulsory announce below — never here.
        postToSlack: false,
        outcome,
      })
      toast.success('Internal note saved')

      const followUps: Array<{ title: string; dueAt?: string | null; assignee?: string | null }> =
        []
      if (createTask && taskAssigneeId) {
        try {
          const isTeam = taskAssigneeId.startsWith('team:')
          await taskCreate.mutateAsync({
            title: taskTitle.trim() || `Follow up: ${contactName}`,
            description: internalNote.trim(),
            contactId,
            assigneeId: isTeam ? undefined : taskAssigneeId.replace(/^user:/, ''),
            teamId: isTeam ? taskAssigneeId.slice('team:'.length) : undefined,
            dueAt: taskDueAt ? new Date(taskDueAt) : undefined,
          })
          followUps.push({
            title: taskTitle.trim() || `Follow up: ${contactName}`,
            dueAt: taskDueAt || null,
            assignee: assigneeLabel(taskAssigneeId),
          })
          toast.success('Task created')
        } catch (e) {
          toast.error(e instanceof Error ? e.message : 'Could not create task')
        }
      }

      // COMPULSORY: post to #callsummaries. If the customer was already sent the
      // summary, the note makes that unmistakable; otherwise it's logged.
      await announceCallSummary({
        disposition: sentChannels.length > 0 ? 'sent_to_customer' : 'logged',
        body: internalNote.trim(),
        sentChannels,
        followUps,
      })

      resetAll()
      router.refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the note')
    } finally {
      setBusy(false)
    }
  }

  // ── Render ─────────────────────────────────────────────────────────
  const steps: Array<{ key: Step; label: string }> =
    sendPath === 'va'
      ? [
          { key: 'who', label: 'Who sends' },
          { key: 'va', label: 'Hand to VA' },
        ]
      : [
          { key: 'who', label: 'Who sends' },
          { key: 'email', label: 'Email' },
          { key: 'text', label: 'Text / WhatsApp' },
          { key: 'internal', label: 'Internal note' },
        ]
  const stepIndex = steps.findIndex((s) => s.key === step)

  return (
    <div className="space-y-3">
      {/* Step rail */}
      <ol className="flex flex-wrap items-center gap-1.5 text-[11px] font-medium">
        {steps.map((s, i) => (
          <li key={s.key} className="flex items-center gap-1.5">
            {i > 0 ? <span className="text-neutral-300">→</span> : null}
            <span
              className={
                i === stepIndex
                  ? 'rounded-full bg-primary-600 px-2.5 py-0.5 text-white'
                  : i < stepIndex
                    ? 'rounded-full bg-emerald-100 px-2.5 py-0.5 text-emerald-800'
                    : 'rounded-full bg-neutral-100 px-2.5 py-0.5 text-neutral-500'
              }
            >
              {i + 1}. {s.label}
              {i < stepIndex ? ' ✓' : ''}
            </span>
          </li>
        ))}
      </ol>

      {step === 'who' ? (
        <div className="rounded-lg border border-primary-200 bg-primary-50/40 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary-900">
            Step 1 — Who&apos;s sending this call summary?
          </p>
          <p className="mt-0.5 text-sm text-neutral-800">
            Send it to {contactName} yourself now, or hand it to a VA to send and clear on the CRM.
            Either way it&apos;s posted to your{' '}
            <span className="font-semibold">#callsummaries</span> Slack channel.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => choosePath('self')}
              className="rounded-lg border border-primary-300 bg-white p-3 text-left transition-colors hover:border-primary-400 hover:bg-primary-50"
            >
              <span className="block text-sm font-semibold text-primary-900">
                ✍️ I&apos;ll send it now
              </span>
              <span className="mt-0.5 block text-xs text-neutral-600">
                Email (full Gmail) and/or WhatsApp / SMS via Trengo, then log an internal note.
              </span>
            </button>
            <button
              type="button"
              onClick={() => choosePath('va')}
              className="rounded-lg border border-amber-300 bg-white p-3 text-left transition-colors hover:border-amber-400 hover:bg-amber-50"
            >
              <span className="block text-sm font-semibold text-amber-900">🤝 Hand it to a VA</span>
              <span className="mt-0.5 block text-xs text-neutral-600">
                Post the summary to #callsummaries — flagged for VA action — and open a task for the
                VA team to send it and clear it on the CRM.
              </span>
            </button>
          </div>
        </div>
      ) : null}

      {step === 'va' ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
                Step 2 — Hand to a VA
              </p>
              <p className="mt-0.5 text-sm text-neutral-800">
                Write the call summary. It is posted to your{' '}
                <span className="font-semibold">#callsummaries</span> Slack channel — clearly
                flagged for the VA team to action — and opens a task to send it and clear it on the
                CRM.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                Call outcome
              </label>
              <Select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as Outcome)}
                aria-label="Call outcome"
                className="w-36"
              >
                <option value="answered">Answered</option>
                <option value="voicemail">Voicemail</option>
                <option value="no_answer">No answer</option>
              </Select>
            </div>
          </div>

          <button
            type="button"
            onClick={draftVaSummary}
            disabled={draftingVa}
            className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-100/70 px-3 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-50"
          >
            <span aria-hidden="true">✨</span>
            {draftingVa ? 'Thinking…' : 'AI draft from latest call'}
          </button>

          <Textarea
            className="mt-2"
            rows={6}
            value={vaBody}
            onChange={(e) => setVaBody(e.target.value)}
            placeholder={`What happened on the call with ${contactName}, and what the VA should send…`}
          />

          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                Task for
              </label>
              <Select
                className="mt-1"
                value={vaTaskTarget || (vaTeam ? `team:${vaTeam.id}` : '')}
                onChange={(e) => setVaTaskTarget(e.target.value)}
                aria-label="VA task assignee"
              >
                <option value="">Choose…</option>
                {teams.length > 0 ? (
                  <optgroup label="Teams">
                    {teams.map((t) => (
                      <option key={t.id} value={`team:${t.id}`}>
                        {t.name} (whole team)
                      </option>
                    ))}
                  </optgroup>
                ) : null}
                <optgroup label="People">
                  {assignableUsers.map((u) => (
                    <option key={u.id} value={`user:${u.id}`}>
                      {u.name ?? u.email}
                    </option>
                  ))}
                </optgroup>
              </Select>
            </div>
            <div>
              <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                Due (optional)
              </label>
              <Input
                className="mt-1"
                type="date"
                value={vaDueAt}
                onChange={(e) => setVaDueAt(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep('who')}
              disabled={busy}
            >
              ← Back
            </Button>
            <Button
              type="button"
              onClick={submitVaHandoff}
              disabled={busy || !vaBody.trim() || !(vaTaskTarget || vaTeam)}
            >
              {busy ? 'Handing off…' : 'Post to #callsummaries & open VA task →'}
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'email' ? (
        <div className="rounded-lg border border-primary-200 bg-primary-50/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary-900">
                Step 1 — Email
              </p>
              <p className="mt-0.5 text-sm text-neutral-800">
                Do you want to send {contactName} an email?
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                Call outcome
              </label>
              <Select
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as Outcome)}
                aria-label="Call outcome"
                className="w-36"
              >
                <option value="answered">Answered</option>
                <option value="voicemail">Voicemail</option>
                <option value="no_answer">No answer</option>
              </Select>
            </div>
          </div>

          <YesNo value={emailWanted} onChange={setEmailWanted} idPrefix="csw-email" />

          {emailWanted ? (
            <div className="mt-3 space-y-3 border-t border-primary-200/60 pt-3">
              {/* Quick start: AI draft + template chips + quick replies */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-neutral-500">
                  Quick start
                </span>
                <button
                  type="button"
                  onClick={draftFromCall}
                  disabled={drafting}
                  className="inline-flex items-center gap-1.5 rounded-full border border-primary-300 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-800 transition-colors hover:bg-primary-100 disabled:opacity-50"
                >
                  <span aria-hidden="true">✨</span>
                  {drafting ? 'Drafting…' : 'AI draft from latest call'}
                </button>
                {templates.map((t) => {
                  const active = t.id === activeTemplateId
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => {
                        setEmailBody(applyNamePlaceholders(t.body, contactName))
                        setActiveTemplateId(t.id)
                      }}
                      className={
                        active
                          ? 'inline-flex items-center gap-1 rounded-full border border-primary-300 bg-primary-50 px-3 py-1 text-xs font-medium text-primary-800'
                          : 'inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700'
                      }
                    >
                      {t.name}
                      {t.hasPdf ? (
                        <span
                          aria-hidden
                          className="rounded bg-primary-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary-800"
                        >
                          PDF
                        </span>
                      ) : null}
                    </button>
                  )
                })}
                {quickReplies.length > 0 ? (
                  <select
                    aria-label="Insert a saved template"
                    value=""
                    onChange={(e) => {
                      insertQuickReply(e.target.value, 'email')
                      e.currentTarget.value = ''
                    }}
                    className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                  >
                    <option value="">Insert template…</option>
                    {quickReplies.map((q) => (
                      <option key={q.id} value={q.id}>
                        {q.title}
                        {q.channel ? ` · ${q.channel}` : ''}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>

              {activeTemplate?.hasPdf ? (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-primary-200 bg-primary-50/50 px-3 py-2 text-xs">
                  <span className="font-medium text-primary-900">
                    Script for {activeTemplate.name}:
                  </span>
                  <a
                    href={`/api/call-summary-templates/${activeTemplate.id}/pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary-800 hover:underline"
                  >
                    Open PDF
                    {activeTemplate.pdfFileName ? ` (${activeTemplate.pdfFileName})` : ''}
                  </a>
                </div>
              ) : null}

              {/* Full-Gmail compose header: From / To / Cc / Bcc */}
              <div className="grid grid-cols-1 gap-2 rounded-md border border-primary-200/60 bg-white/60 p-2 sm:grid-cols-2">
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    From
                  </label>
                  {mailboxes.length > 0 ? (
                    <Select
                      className="mt-1"
                      value={emailFrom}
                      onChange={(e) => setEmailFrom(e.target.value)}
                      aria-label="Send from"
                    >
                      {mailboxes.map((m) => (
                        <option key={m.address} value={m.address}>
                          {m.address}
                          {m.isDefault ? ' (default)' : ''}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <p className="mt-1 text-[11px] text-neutral-500">
                      Your default connected mailbox.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    To
                  </label>
                  <Input
                    className="mt-1"
                    value={emailTo}
                    onChange={(e) => setEmailTo(e.target.value)}
                    placeholder="Contact's email on file"
                  />
                </div>
                {showCcBcc ? (
                  <>
                    <div>
                      <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                        Cc
                      </label>
                      <Input
                        className="mt-1"
                        value={emailCc}
                        onChange={(e) => setEmailCc(e.target.value)}
                        placeholder="name@example.com, …"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                        Bcc
                      </label>
                      <Input
                        className="mt-1"
                        value={emailBcc}
                        onChange={(e) => setEmailBcc(e.target.value)}
                        placeholder="name@example.com, …"
                      />
                    </div>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowCcBcc(true)}
                    className="self-end text-left text-[11px] font-medium text-primary-700 hover:underline sm:col-span-2"
                  >
                    + Add Cc / Bcc
                  </button>
                )}
              </div>

              <div>
                <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                  Subject (used for a new email; a reply keeps the thread&apos;s subject)
                </label>
                <Input
                  className="mt-1"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  placeholder="Following up on our call"
                />
                <p className="mt-1 text-[10px] text-neutral-500">
                  Setting a From or To address sends a fresh email instead of replying on the latest
                  thread.
                </p>
              </div>

              <Textarea
                rows={6}
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                placeholder={`What to email ${contactName} after the call…`}
              />

              {/* Attachments — email only */}
              <div className="border-t border-primary-200/60 pt-2">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-primary-900/80">
                  Attach documents ({pickedAttachments.length + uploadedFiles.length})
                </p>
                <p className="mt-0.5 text-[10px] text-primary-900/60">
                  Info packs &amp; brochures come from the shared library (Settings → Documents).
                  Everything here rides the email.
                </p>

                <div className="mt-1.5">
                  <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-primary-300 bg-white px-2.5 py-1 text-xs font-medium text-primary-700 transition-colors hover:bg-primary-50">
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      onChange={(e) => {
                        void onPickFiles(e.target.files)
                        e.currentTarget.value = ''
                      }}
                    />
                    Upload a file…
                  </label>
                  {uploadedFiles.length > 0 ? (
                    <ul className="mt-1.5 space-y-1">
                      {uploadedFiles.map((f, i) => (
                        <li
                          key={`${f.filename}:${i}`}
                          className="flex items-center gap-2 rounded border border-neutral-200 bg-white px-2 py-1 text-xs"
                        >
                          <span className="min-w-0 flex-1 truncate text-neutral-700">
                            {f.filename}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] text-neutral-400">
                            {Math.max(1, Math.round(f.size / 1024))} KB
                          </span>
                          <button
                            type="button"
                            onClick={() => removeUpload(i)}
                            aria-label={`Remove ${f.filename}`}
                            className="shrink-0 px-1 text-neutral-400 hover:text-neutral-700"
                          >
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                {attachmentChoices.length > 0 ? (
                  <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto pr-1">
                    {attachmentChoices.map((c) => (
                      <li key={`${c.kind}:${c.id}`}>
                        <label className="flex items-start gap-2 text-xs text-neutral-700">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-3.5 w-3.5 rounded border-neutral-300 text-primary-600 focus:ring-primary-500"
                            checked={isPicked(c)}
                            onChange={(e) => toggleAttachment(c, e.target.checked)}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {c.label}
                              {c.kind === 'infoPack' ? (
                                <span
                                  aria-hidden
                                  className="ml-1.5 rounded bg-primary-100 px-1 text-[9px] font-semibold uppercase tracking-wide text-primary-800"
                                >
                                  Library
                                </span>
                              ) : null}
                            </span>
                            {c.hint && (
                              <span className="block text-[10px] text-neutral-500">{c.hint}</span>
                            )}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[11px] text-neutral-500">
                    No saved documents yet — admins can add info packs at Settings → Documents.
                  </p>
                )}
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep('who')}
              disabled={busy}
            >
              ← Back
            </Button>
            <Button
              type="button"
              onClick={continueToText}
              disabled={busy || emailWanted === null || (emailWanted === true && !emailBody.trim())}
            >
              Continue →
            </Button>
          </div>
        </div>
      ) : null}

      {step === 'text' ? (
        <div className="rounded-lg border border-primary-200 bg-primary-50/40 p-3">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-primary-900">
            Step 2 — Text message
          </p>
          <p className="mt-0.5 text-sm text-neutral-800">
            Send {contactName} a WhatsApp or SMS as well?
          </p>

          <YesNo value={textWanted} onChange={setTextWanted} idPrefix="csw-text" />

          {textWanted ? (
            <div className="mt-3 space-y-3 border-t border-primary-200/60 pt-3">
              <div className="flex flex-wrap items-center gap-3">
                {(['whatsapp', 'sms'] as const).map((ch) => (
                  <label
                    key={ch}
                    className="inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700"
                  >
                    <input
                      type="radio"
                      name="csw-text-channel"
                      className="h-4 w-4 border-neutral-300 text-primary-600 focus:ring-primary-500"
                      checked={textChannel === ch}
                      onChange={() => setTextChannel(ch)}
                    />
                    {ch === 'whatsapp' ? 'WhatsApp (via Trengo)' : 'SMS (via Trengo)'}
                  </label>
                ))}
              </div>

              {/* Sender line — which Trengo number to send a NEW conversation
                  from. An existing thread keeps its own line. */}
              {trengoLinesForChannel.length > 1 ? (
                <div className="max-w-sm">
                  <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    Send from line
                  </label>
                  <Select
                    className="mt-1"
                    value={trengoChannelId}
                    onChange={(e) => setTrengoChannelId(e.target.value)}
                    aria-label="Trengo sender line"
                  >
                    <option value="">Workspace default</option>
                    {trengoLinesForChannel.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <p className="mt-1 text-[10px] text-neutral-500">
                    Only applies when starting a new conversation; an existing thread keeps its
                    line.
                  </p>
                </div>
              ) : null}

              {textChannel === 'whatsapp' ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setWaMode('template')}
                      className={
                        waMode === 'template'
                          ? 'rounded-full border border-primary-300 bg-primary-100 px-3 py-1 text-xs font-medium text-primary-900'
                          : 'rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:border-primary-300'
                      }
                    >
                      Trengo template
                    </button>
                    <button
                      type="button"
                      onClick={() => setWaMode('custom')}
                      className={
                        waMode === 'custom'
                          ? 'rounded-full border border-primary-300 bg-primary-100 px-3 py-1 text-xs font-medium text-primary-900'
                          : 'rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:border-primary-300'
                      }
                    >
                      Free text
                    </button>
                  </div>

                  {waMode === 'template' ? (
                    <div className="space-y-2">
                      <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                        Your approved Trengo templates already include the info-pack links — no PDF
                        attachments here, that would duplicate them. Templates send even outside the
                        24-hour WhatsApp window.
                      </p>
                      {waTemplatesQuery.isLoading ? (
                        <p className="text-xs text-neutral-500">Loading templates from Trengo…</p>
                      ) : waTemplatesQuery.data?.available === false ? (
                        <p className="text-xs text-neutral-600">
                          {waTemplatesQuery.data.reason} Use free text instead.
                        </p>
                      ) : waTemplates.length === 0 ? (
                        <p className="text-xs text-neutral-600">
                          No approved WhatsApp templates in your Trengo workspace yet — use free
                          text instead.
                        </p>
                      ) : (
                        <>
                          <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
                            {waTemplates.map((t) => (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => {
                                  setWaTemplateId(t.id)
                                  setWaParams({})
                                }}
                                aria-pressed={t.id === waTemplateId}
                                className={
                                  t.id === waTemplateId
                                    ? 'block w-full rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-left'
                                    : 'block w-full rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-left transition-colors hover:border-emerald-300 hover:bg-emerald-50/50'
                                }
                              >
                                <span
                                  className={
                                    t.id === waTemplateId
                                      ? 'block text-xs font-semibold text-emerald-900'
                                      : 'block text-xs font-semibold text-neutral-800'
                                  }
                                >
                                  {t.title}
                                </span>
                                <span className="block truncate text-[11px] text-neutral-500">
                                  {t.body.replace(/\s+/g, ' ')}
                                </span>
                              </button>
                            ))}
                          </div>
                          {waTemplate ? (
                            <WaTemplateComposer
                              body={waTemplate.body}
                              paramKeys={waTemplate.params}
                              values={waParams}
                              contactName={contactName}
                              onChange={(key, value) =>
                                setWaParams((prev) => ({ ...prev, [key]: value }))
                              }
                            />
                          ) : (
                            <p className="text-xs text-neutral-500">Pick a template above.</p>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <p className="text-[11px] text-neutral-500">
                        Free text continues their WhatsApp thread (or starts one). Outside the
                        24-hour window WhatsApp may reject it — use a template then.
                      </p>
                      {quickReplies.length > 0 ? (
                        <select
                          aria-label="Insert a saved reply"
                          value=""
                          onChange={(e) => {
                            insertQuickReply(e.target.value, 'text')
                            e.currentTarget.value = ''
                          }}
                          className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                        >
                          <option value="">Insert quick reply…</option>
                          {quickReplies.map((q) => (
                            <option key={q.id} value={q.id}>
                              {q.title}
                              {q.channel ? ` · ${q.channel}` : ''}
                            </option>
                          ))}
                        </select>
                      ) : null}
                      <Textarea
                        rows={4}
                        value={textBody}
                        onChange={(e) => setTextBody(e.target.value)}
                        placeholder={`What to WhatsApp ${contactName}…`}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-1.5">
                  {quickReplies.length > 0 ? (
                    <select
                      aria-label="Insert a saved reply"
                      value=""
                      onChange={(e) => {
                        insertQuickReply(e.target.value, 'text')
                        e.currentTarget.value = ''
                      }}
                      className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 transition-colors hover:border-primary-300 hover:text-primary-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    >
                      <option value="">Insert quick reply…</option>
                      {quickReplies.map((q) => (
                        <option key={q.id} value={q.id}>
                          {q.title}
                          {q.channel ? ` · ${q.channel}` : ''}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <Textarea
                    rows={4}
                    value={textBody}
                    onChange={(e) => setTextBody(e.target.value)}
                    placeholder={`What to text ${contactName}…`}
                  />
                  <p className="text-[11px] text-neutral-500">
                    Sent via Trengo — continues their SMS thread, or starts one to their number.
                  </p>
                </div>
              )}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => setStep('email')}
              disabled={busy}
            >
              ← Back
            </Button>
            <Button type="button" onClick={sendNow} disabled={busy || textWanted === null}>
              {busy
                ? 'Sending…'
                : emailWanted || textWanted
                  ? 'Send now →'
                  : 'Skip to internal note →'}
            </Button>
          </div>
          <p className="mt-2 text-[11px] text-neutral-500">
            Each channel is best-effort and independent — one failing channel never aborts the
            others. Next you&apos;ll add an internal note for the team.
          </p>
        </div>
      ) : null}

      {step === 'internal' ? (
        <div className="space-y-3">
          {sentSomething && summaryId ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2">
              <span aria-hidden className="text-emerald-700">
                ✓
              </span>
              <p className="text-sm text-emerald-900">
                Customer summary saved and sent. Now log the internal note.
              </p>
            </div>
          ) : null}

          <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3">
            <div className="flex items-center gap-2">
              <span aria-hidden className="text-amber-700">
                🔒
              </span>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-900">
                Step 3 — Internal note &amp; next steps
              </p>
            </div>
            <p className="mt-0.5 text-xs text-amber-900/70">
              Not seen by the customer. What happened, and what the team / VA needs to do next.
            </p>

            <button
              type="button"
              onClick={suggestInternalNote}
              disabled={draftingNote}
              className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-100/70 px-3 py-1 text-xs font-medium text-amber-900 transition-colors hover:bg-amber-100 disabled:opacity-50"
            >
              <span aria-hidden="true">✨</span>
              {draftingNote ? 'Thinking…' : 'AI suggest next steps'}
            </button>

            <Textarea
              className="mt-2"
              rows={5}
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
              placeholder="What happened on the call, plus next steps / instructions for the VA team…"
            />

            <div className="mt-3 flex items-start gap-2 rounded-md border border-emerald-200 bg-emerald-50/70 px-3 py-2">
              <span aria-hidden className="text-emerald-700">
                #
              </span>
              <p className="text-xs text-emerald-900">
                This call summary is posted to your{' '}
                <span className="font-semibold">#callsummaries</span> Slack channel automatically.{' '}
                {sentChannels.length > 0 ? (
                  <>
                    It will be clearly flagged as{' '}
                    <span className="font-semibold">already sent to the customer</span> (
                    {sentChannels.join(', ')}).
                  </>
                ) : (
                  <>It will be logged for the team (no customer message was sent).</>
                )}{' '}
                Any follow-up task you add below is included in the Slack note.
              </p>
            </div>

            <label className="mt-3 inline-flex cursor-pointer items-center gap-2 text-sm text-neutral-700">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-neutral-300 text-amber-600 focus:ring-amber-500"
                checked={createTask}
                onChange={(e) => setCreateTask(e.target.checked)}
              />
              Also open a follow-up task (for a person or a whole team)
            </label>

            {createTask ? (
              <div className="ml-6 mt-2 grid max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    Task title
                  </label>
                  <Input
                    value={taskTitle}
                    onChange={(e) => setTaskTitle(e.target.value)}
                    placeholder={`Follow up: ${contactName}`}
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    Assign to
                  </label>
                  <Select
                    value={taskAssigneeId}
                    onChange={(e) => setTaskAssigneeId(e.target.value)}
                    aria-label="Task assignee"
                  >
                    <option value="">Choose…</option>
                    {teams.length > 0 ? (
                      <optgroup label="Teams">
                        {teams.map((t) => (
                          <option key={t.id} value={`team:${t.id}`}>
                            {t.name} (whole team)
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                    <optgroup label="People">
                      {assignableUsers.map((u) => (
                        <option key={u.id} value={`user:${u.id}`}>
                          {u.name ?? u.email}
                        </option>
                      ))}
                    </optgroup>
                  </Select>
                </div>
                <div>
                  <label className="block text-[10px] font-medium uppercase tracking-wide text-neutral-500">
                    Due (optional)
                  </label>
                  <Input
                    type="date"
                    value={taskDueAt}
                    onChange={(e) => setTaskDueAt(e.target.value)}
                  />
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={submitInternal} disabled={busy || !internalNote.trim()}>
              {busy ? 'Saving…' : 'Save internal note'}
            </Button>
            <Button type="button" variant="secondary" onClick={resetAll} disabled={busy}>
              Skip &amp; log another call
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * The Trengo-style template composer: the message is shown as a WhatsApp
 * bubble with the fill-in fields embedded inline at the exact {{n}}
 * positions, so what you see is literally what the customer receives. The
 * surrounding template text is fixed (WhatsApp HSM rules) — only the blanks
 * are editable. A repeated {{n}} mirrors the value typed into its first slot.
 */
function WaTemplateComposer({
  body,
  paramKeys,
  values,
  contactName,
  onChange,
}: {
  body: string
  paramKeys: ReadonlyArray<string>
  values: Record<string, string>
  contactName: string
  onChange: (key: string, value: string) => void
}) {
  const segments = parseWaTemplateSegments(body)
  const missing = missingWaParams(paramKeys, values)

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-900/80">
          Message to {contactName} — fill in the blanks
        </p>
        {paramKeys.length > 0 ? (
          missing.length > 0 ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
              {missing.length} blank{missing.length > 1 ? 's' : ''} to fill
            </span>
          ) : (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-800">
              Ready to send ✓
            </span>
          )
        ) : null}
      </div>

      {/* The outgoing WhatsApp bubble. */}
      <div className="mt-2 max-w-xl rounded-2xl rounded-br-sm border border-emerald-200 bg-white px-3 py-2 shadow-sm">
        <p className="whitespace-pre-wrap text-sm leading-7 text-neutral-900">
          {segments.map((seg, i) => {
            if (seg.kind === 'text') {
              return <span key={i}>{seg.text}</span>
            }
            const value = values[seg.key] ?? ''
            if (!seg.first) {
              // Mirror of an earlier blank — WhatsApp substitutes every
              // occurrence with the same value.
              return (
                <span
                  key={i}
                  className={
                    value.trim()
                      ? 'mx-0.5 rounded bg-emerald-100 px-1 font-medium text-emerald-900'
                      : 'mx-0.5 rounded bg-amber-50 px-1 font-medium text-amber-700'
                  }
                >
                  {value.trim() || seg.key}
                </span>
              )
            }
            return (
              <input
                key={i}
                type="text"
                value={value}
                onChange={(e) => onChange(seg.key, e.target.value)}
                placeholder={seg.key}
                aria-label={`Template field ${seg.key}`}
                style={{ width: `${Math.min(Math.max(value.length, seg.key.length) + 2, 42)}ch` }}
                className={
                  value.trim()
                    ? 'mx-0.5 inline-block rounded-md border border-emerald-300 bg-emerald-50 px-1.5 py-0 align-baseline text-sm font-medium text-emerald-900 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500'
                    : 'mx-0.5 inline-block rounded-md border border-dashed border-amber-400 bg-amber-50 px-1.5 py-0 align-baseline text-sm font-medium text-amber-900 placeholder:text-amber-500 focus:border-solid focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500'
                }
              />
            )
          })}
        </p>
        <p className="mt-1 text-right text-[10px] text-neutral-400">
          WhatsApp template · via Trengo
        </p>
      </div>

      <p className="mt-1.5 text-[10px] text-emerald-900/60">
        The wording is fixed by the approved template — only the highlighted blanks are yours to
        fill. It sends exactly as shown.
      </p>
    </div>
  )
}

/** The wizard's Yes / No question control. */
function YesNo({
  value,
  onChange,
  idPrefix,
}: {
  value: boolean | null
  onChange: (v: boolean) => void
  idPrefix: string
}) {
  return (
    <div className="mt-2 flex items-center gap-2" role="radiogroup" aria-label="Yes or no">
      <button
        type="button"
        id={`${idPrefix}-yes`}
        role="radio"
        aria-checked={value === true}
        onClick={() => onChange(true)}
        className={
          value === true
            ? 'rounded-md border border-primary-400 bg-primary-600 px-4 py-1.5 text-sm font-medium text-white'
            : 'rounded-md border border-neutral-200 bg-white px-4 py-1.5 text-sm font-medium text-neutral-700 hover:border-primary-300 hover:bg-primary-50'
        }
      >
        Yes
      </button>
      <button
        type="button"
        id={`${idPrefix}-no`}
        role="radio"
        aria-checked={value === false}
        onClick={() => onChange(false)}
        className={
          value === false
            ? 'rounded-md border border-neutral-400 bg-neutral-700 px-4 py-1.5 text-sm font-medium text-white'
            : 'rounded-md border border-neutral-200 bg-white px-4 py-1.5 text-sm font-medium text-neutral-700 hover:border-neutral-300 hover:bg-neutral-50'
        }
      >
        No
      </button>
    </div>
  )
}
