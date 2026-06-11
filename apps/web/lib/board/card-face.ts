// Card-face configuration (UI roadmap increment 4). Which preview fields show
// on every card on a board. Stored on `Board.cardFields` as a JSON array of
// these keys; NULL means "show all" (back-compat). Managers edit it from the
// board settings page — no code change to declutter a board.

export const CARD_FACE_FIELDS = [
  { key: 'contact', label: 'Phone & email' },
  { key: 'subject', label: 'Subject' },
  { key: 'company', label: 'Company' },
  { key: 'enquiryType', label: 'Enquiry type' },
  { key: 'labels', label: 'Labels' },
  { key: 'description', label: 'Note preview' },
  { key: 'scheduledCall', label: 'Scheduled call' },
  { key: 'priority', label: 'Priority flag' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'dueDate', label: 'Due date' },
  { key: 'lastActivity', label: 'Last activity' },
] as const

export type CardFaceKey = (typeof CARD_FACE_FIELDS)[number]['key']

const ALL_KEYS = CARD_FACE_FIELDS.map((f) => f.key) as CardFaceKey[]

/** Every key — the default when a board has no explicit config. */
export const DEFAULT_CARD_FACE: CardFaceKey[] = [...ALL_KEYS]

/** Parse the persisted `Board.cardFields`. Returns null ("show all") for an
 * unset/garbage value so a board always renders something sensible. */
export function parseCardFace(raw: unknown): CardFaceKey[] | null {
  if (!Array.isArray(raw)) return null
  const valid = raw.filter((k): k is CardFaceKey => ALL_KEYS.includes(k as CardFaceKey))
  return valid.length > 0 ? valid : null
}

/** Whether a given field should render. null config => everything shows. */
export function cardFaceHas(fields: CardFaceKey[] | null | undefined, key: CardFaceKey): boolean {
  return fields == null ? true : fields.includes(key)
}
