// Envelope encryption primitives. Originally built for safeguarding notes
// (see ADR 0013); retained because Gmail OAuth refresh-token storage and
// any future field that needs crypto-shred on erasure rely on the same
// CMK + per-row DEK shape. Folder name preserved for path stability.

export const SAFEGUARDING_DOMAIN = 'safeguarding' as const

export * from './decrypt'
export * from './encrypt'
export { generateDataKey, unwrapDataKey, type GeneratedDataKey } from './envelope'
export { getKmsClient, setKmsClient, getKmsKeyId, isKmsConfigured, KEY_VERSION } from './kms'
