// Default forwarding rule catalogue. Mirrors the rules seeded by the
// migration so tests and the seed script share one source of truth. The
// migration writes these rows on first deploy; the admin UI can rename,
// reorder, change recipients, or archive any of them afterwards.

export interface DefaultForwardingRule {
  key: string
  label: string
  description: string
  toAddresses: readonly string[]
  ccAddresses: readonly string[]
  subjectTemplate: string
  bodyTemplate: string
  sortOrder: number
}

const STANDARD_BODY = (
  greeting: string,
): string => `Hi ${greeting},

{{notes}}

Contact details:
- Name: {{contactName}}
- Email: {{contactEmail}}
- Phone: {{contactPhone}}
- CRM link: {{contactLink}}

Thanks,
{{agentName}}`

export const DEFAULT_FORWARDING_RULES: readonly DefaultForwardingRule[] = [
  {
    key: 'ap_team',
    label: 'Forward to AP Team',
    description: 'Send a query about a contact to the AP team.',
    toAddresses: ['ap@studymind.co.uk'],
    ccAddresses: [],
    subjectTemplate: 'Forwarded query: {{contactName}}',
    bodyTemplate: STANDARD_BODY('AP team'),
    sortOrder: 10,
  },
  {
    key: 'ap_recruitment',
    label: 'Forward to AP Recruitment',
    description: "Send tutor recruitment-related queries; cc'd to Sid and Lewis.",
    toAddresses: ['recruitment@studymind.co.uk'],
    ccAddresses: ['sid@studymind.co.uk', 'lewis@studymind.co.uk'],
    subjectTemplate: 'Recruitment query: {{contactName}}',
    bodyTemplate: STANDARD_BODY('recruitment team'),
    sortOrder: 20,
  },
  {
    key: 'ceos',
    label: 'Forward to CEOs',
    description: 'Escalate to the leadership team.',
    toAddresses: [
      'mohil@studymind.co.uk',
      'kunal@studymind.co.uk',
      'business@studymind.co.uk',
    ],
    ccAddresses: [],
    subjectTemplate: 'Escalation: {{contactName}}',
    bodyTemplate: STANDARD_BODY('team'),
    sortOrder: 30,
  },
  {
    key: 'schools',
    label: 'Forward to Schools',
    description: 'Schools partnerships queries.',
    toAddresses: ['schools@studymind.co.uk'],
    ccAddresses: [],
    subjectTemplate: 'Schools query: {{contactName}}',
    bodyTemplate: STANDARD_BODY('schools team'),
    sortOrder: 40,
  },
  {
    key: 'camps',
    label: 'Forward to Camps',
    description: 'Camps-related queries.',
    toAddresses: ['camps@studymind.co.uk'],
    ccAddresses: [],
    subjectTemplate: 'Camps query: {{contactName}}',
    bodyTemplate: STANDARD_BODY('camps team'),
    sortOrder: 50,
  },
  {
    key: 'partnerships',
    label: 'Forward to Partnerships',
    description: 'Partnerships and B2B opportunities.',
    toAddresses: ['partnerships@studymind.co.uk'],
    ccAddresses: [],
    subjectTemplate: 'Partnerships query: {{contactName}}',
    bodyTemplate: STANDARD_BODY('partnerships team'),
    sortOrder: 60,
  },
] as const
