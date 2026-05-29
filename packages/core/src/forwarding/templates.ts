// Plain `{{varName}}` substitution for forwarding subject/body templates.
// Deliberately tiny — Handlebars would be overkill and bring escaping
// surprises. Unknown variables render as an empty string (no `{{...}}`
// leaks into outbound email) so a partially-filled contact never blocks a
// send. Curly braces in user text are preserved because we only match
// `{{<identifier>}}`.

import type { ForwardingTemplateContext } from './types'

const VAR_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g

/**
 * Substitute `{{varName}}` tokens against the context. Unknown variables and
 * empty values both render as ''. The template string itself is otherwise
 * passed through unchanged.
 */
export function renderTemplate(
  template: string,
  context: ForwardingTemplateContext,
): string {
  return template.replace(VAR_RE, (_match, name: string) => {
    const value = (context as Record<string, unknown>)[name]
    return typeof value === 'string' ? value : ''
  })
}

/** List of supported variable names — surfaced in the admin UI helper. */
export const TEMPLATE_VARIABLES = [
  'contactName',
  'contactEmail',
  'contactPhone',
  'contactId',
  'contactLink',
  'familyName',
  'agentName',
  'agentEmail',
  'notes',
] as const
