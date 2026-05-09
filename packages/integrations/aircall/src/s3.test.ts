// S3 putRecording / getRecording with mocked S3Client.

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { mockClient } from 'aws-sdk-client-mock'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getRecordingBuffer, putRecording, setS3Client } from './s3'

const s3Mock = mockClient(S3Client)

beforeEach(() => {
  process.env['AWS_REGION'] = 'eu-west-2'
  process.env['S3_RECORDINGS_BUCKET'] = 'studymind-test-recordings'
  process.env['AWS_KMS_KEY_ID'] = 'alias/crm-test'
  s3Mock.reset()
  setS3Client(new S3Client({ region: 'eu-west-2' }))
})

afterEach(() => {
  setS3Client(null)
  s3Mock.reset()
})

describe('putRecording', () => {
  it('puts the object with SSE-KMS and the correct key shape', async () => {
    s3Mock.on(PutObjectCommand).resolves({})
    const result = await putRecording({
      callId: 12345,
      body: Buffer.from('audio-bytes'),
      contentType: 'audio/mpeg',
    })
    expect(result.s3Key).toBe('aircall/recordings/12345')
    const calls = s3Mock.commandCalls(PutObjectCommand)
    expect(calls).toHaveLength(1)
    const args = calls[0]?.args[0]?.input
    expect(args?.Bucket).toBe('studymind-test-recordings')
    expect(args?.Key).toBe('aircall/recordings/12345')
    expect(args?.ContentType).toBe('audio/mpeg')
    expect(args?.ServerSideEncryption).toBe('aws:kms')
    expect(args?.SSEKMSKeyId).toBe('alias/crm-test')
  })

  it('idempotent overwrite — calling twice with the same key just sends two puts', async () => {
    s3Mock.on(PutObjectCommand).resolves({})
    await putRecording({ callId: 9, body: Buffer.from('a'), contentType: 'audio/mpeg' })
    await putRecording({ callId: 9, body: Buffer.from('b'), contentType: 'audio/mpeg' })
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(2)
    expect(s3Mock.commandCalls(PutObjectCommand)[0]?.args[0]?.input?.Key).toBe(
      'aircall/recordings/9',
    )
  })
})

describe('getRecordingBuffer', () => {
  it('streams the body into a Buffer', async () => {
    const body = Readable.from([Buffer.from('part-1'), Buffer.from('part-2')])
    s3Mock.on(GetObjectCommand).resolves({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Body: body as any,
    })
    const buf = await getRecordingBuffer('aircall/recordings/9')
    expect(buf.toString('utf8')).toBe('part-1part-2')
  })
})
