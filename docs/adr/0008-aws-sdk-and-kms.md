# ADR 0008: AWS SDK adoption (KMS + S3)

- Status: Accepted
- Date: 2026-05-09

## Context

Slice 5 shipped the field-level encryption seam with a deterministic dev stub
(`keyVersion === 0`) and left a TODO to wire real AWS KMS. Slice 6 lands two
adjacent needs that both want the AWS SDK:

- **KMS envelope encryption** for safeguarding fields and per-agent Trengo
  tokens (CLAUDE.md §21.1). Production decryption must call `KMS.Decrypt` with
  associated authenticated data so a tampered AAD fails closed.
- **S3 persistence of Aircall recordings** before Aircall's retention window
  expires (CLAUDE.md §10, §32). Server-side encryption uses the same KMS CMK.

We need to pick a client library and pin it in two packages without
duplicating it across the monorepo.

## Decision

Adopt **`@aws-sdk/client-kms`** and **`@aws-sdk/client-s3`** (AWS SDK for
JavaScript v3, modular). Pin to the current minor (`^3.658.0`) and let
Renovate float patch upgrades.

- `@aws-sdk/client-kms` is added to `packages/core` (encryption is core
  domain logic — every package that decrypts goes through `packages/core`).
- `@aws-sdk/client-s3` is added to `packages/integrations/aircall` (the only
  service that persists binary blobs in Slice 6). Future integrations (Gmail
  attachments, DSAR exports) will add their own dependency at the
  integration that owns the bucket prefix.

Both packages read region and key id from `AWS_REGION`, `AWS_KMS_KEY_ID`,
`S3_RECORDINGS_BUCKET`. Credentials are picked up from the default chain
(IAM role on Railway / EC2; `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
locally).

## Alternatives considered

- **`aws-sdk` v2** (the monolithic legacy SDK). Rejected. Bundle size is an
  order of magnitude larger because it ships every service in one package.
  AWS announced maintenance mode in 2023 and full deprecation in 2026; we are
  not adopting a library that is end-of-life this year.
- **Boto-style raw HTTP signing.** Rejected. Re-implementing SigV4 plus the
  KMS Decrypt envelope is a security-critical exercise we have no business
  doing. The third-party packages (`aws4`, `aws4fetch`) push the burden onto
  us and we lose AWS support for retries, paginators, and adaptive
  throttling.

## Consequences

- **Bundle size.** v3 is modular: only the two service clients land in our
  bundles. Each is small (KMS ~300 KB, S3 ~700 KB unminified) and only
  imported by `packages/core` and `packages/integrations/aircall` so the
  Next.js client bundle is unaffected.
- **Pinning policy.** Floating-patch via Renovate. Major upgrades are an
  ADR.
- **IAM minimum permissions.**
  - `kms:GenerateDataKey`, `kms:Decrypt`, `kms:DescribeKey` on the
    environment CMK only (`crm-prod`, `crm-staging`, `crm-dev`).
  - `s3:PutObject`, `s3:GetObject` on `arn:aws:s3:::studymind-crm-*-recordings/*`.
  - No `kms:*` or `s3:*` wildcards. The `web` and `worker` Railway services
    each get a dedicated IAM role; break-glass DSL access is a separate role
    with `kms:Decrypt` only and is audited (CLAUDE.md §21.1).
- **Local dev.** `localstack` provides KMS and S3 endpoints; the SDK
  honours `AWS_ENDPOINT_URL` so no code branches.
- **Observability.** SDK middleware emits OTel spans tagged
  `provider=aws.{kms|s3}` so AAD failures and 5xx errors surface alongside
  webhook traces.
