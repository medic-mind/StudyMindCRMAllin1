import { describe, expect, it } from 'vitest'

import { pickSignatureForAddress, type MailSendAs } from './signature'

const SAS: MailSendAs[] = [
  { email: 'agent@studymind.co.uk', signatureHtml: '<p>Agent sig</p>', isPrimary: true },
  { email: 'info@studymind.co.uk', signatureHtml: '<p>Info sig</p>', isDefault: true },
  { email: 'empty@studymind.co.uk', signatureHtml: '<div><br></div>' },
]

describe('pickSignatureForAddress', () => {
  it('prefers the exact address match', () => {
    expect(pickSignatureForAddress(SAS, 'info@studymind.co.uk')).toBe('<p>Info sig</p>')
    expect(pickSignatureForAddress(SAS, 'AGENT@studymind.co.uk')).toBe('<p>Agent sig</p>')
  })

  it('falls back to default, then primary', () => {
    expect(pickSignatureForAddress(SAS, 'unknown@x.test')).toBe('<p>Info sig</p>')
    const noDefault = SAS.filter((s) => !s.isDefault)
    expect(pickSignatureForAddress(noDefault, 'unknown@x.test')).toBe('<p>Agent sig</p>')
  })

  it('treats a visually-empty signature as none', () => {
    expect(pickSignatureForAddress(SAS, 'empty@studymind.co.uk')).toBe('<p>Info sig</p>')
    expect(
      pickSignatureForAddress(
        [{ email: 'x@x.test', signatureHtml: '   <div>&nbsp;</div> ' }],
        'x@x.test',
      ),
    ).toBeNull()
  })

  it('returns null when nothing carries a signature', () => {
    expect(
      pickSignatureForAddress([{ email: 'x@x.test', signatureHtml: null }], 'x@x.test'),
    ).toBeNull()
    expect(pickSignatureForAddress([], 'x@x.test')).toBeNull()
  })
})
