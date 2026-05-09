// Safeguarding domain. See CLAUDE.md Section 21.1 and Section 42.

export const SAFEGUARDING_DOMAIN = 'safeguarding' as const

export * from './decrypt'
export * from './encrypt'
export { getKmsClient, setKmsClient, getKmsKeyId, KEY_VERSION } from './kms'
