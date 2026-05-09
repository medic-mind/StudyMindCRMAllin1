# StudyMind CRM — AWS Terraform

This directory holds the AWS infrastructure for the CRM: KMS CMKs, S3 buckets, lifecycle rules, cross-region replication, and the IAM policies that bind the Railway services to these resources. CLAUDE.md §21.1, §32, §46.2.

The HCL here is **author-only** for now. We do **not** apply from CI.

## What is managed here

- **KMS** customer master keys per environment (`crm-prod`, `crm-staging`, `crm-dev`). Production is multi-region (eu-west-2 primary, eu-west-1 replica) so a regional outage does not lock the data.
- **S3 buckets** for recordings, attachments, DSAR exports, cost reports, audit archives, and backups. Versioning on, MFA-delete on production. Cross-region replication to `eu-west-1` for production.
- **Lifecycle rules** mirroring CLAUDE.md §32: recordings standard → IA → expire (with `retain=long` override), attachments standard 90 d → Glacier, audit-archives Glacier Deep Archive after 30 d.
- **IAM policies** for the Railway `web` and `worker` services with least privilege.

## State backend

Remote state lives in S3 (`studymind-crm-tfstate`) with a DynamoDB lock table (`studymind-crm-tfstate-lock`). Both are bootstrapped manually before the first `apply` — they cannot live inside the same state they back.

```bash
aws s3api create-bucket --bucket studymind-crm-tfstate \
  --region eu-west-2 --create-bucket-configuration LocationConstraint=eu-west-2
aws s3api put-bucket-versioning --bucket studymind-crm-tfstate \
  --versioning-configuration Status=Enabled
aws dynamodb create-table --table-name studymind-crm-tfstate-lock \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST --region eu-west-2
```

## Workflow

```bash
cd infra/terraform

# Plan against an env (uses workspaces).
terraform workspace select prod || terraform workspace new prod
terraform init
terraform plan -var-file=env.prod.tfvars

# Apply — only after the plan is reviewed by the tech lead.
terraform apply -var-file=env.prod.tfvars
```

## Outputs

Surface these into Railway env vars after each apply:

| Terraform output | Railway env var |
| --- | --- |
| `kms_key_id` | `AWS_KMS_KEY_ID` |
| `s3_bucket_names.recordings` | `S3_RECORDINGS_BUCKET` |
| `s3_bucket_names.attachments` | `S3_ATTACHMENTS_BUCKET` |
| `s3_bucket_names.dsar` | `S3_DSAR_BUCKET` |
| `s3_bucket_names.cost_reports` | `S3_COST_REPORTS_BUCKET` |
| `s3_bucket_names.audit_archives` | `S3_AUDIT_ARCHIVES_BUCKET` |
| `s3_bucket_names.backups` | `S3_BACKUPS_BUCKET` |

## Required tfvars per environment

```hcl
# env.prod.tfvars
env  = "prod"
railway_web_principal_arn      = "arn:aws:iam::<acct>:user/railway-crm-web-prod"
railway_worker_principal_arn   = "arn:aws:iam::<acct>:user/railway-crm-worker-prod"
break_glass_dsl_principal_arn  = "arn:aws:iam::<acct>:role/dsl-break-glass"
```

## Destroying

`terraform destroy` is gated by tech-lead sign-off. KMS deletion is delayed by 30 days; that window is the safety net for "we destroyed staging by mistake".

## Disaster recovery

See `docs/runbooks/disaster-recovery.md` for the procedure that consumes these resources. The replica region (eu-west-1) is the recovery target if eu-west-2 is unavailable.
