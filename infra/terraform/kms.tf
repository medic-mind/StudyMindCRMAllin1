# KMS Customer Master Keys (CMKs) per environment. CLAUDE.md §21.1.
#
# Production is multi-region so a regional outage does not lock the data.
# Staging and dev are single-region for cost.

locals {
  is_prod = var.env == "prod"
  cmk_alias = "alias/crm-${var.env}"
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "crm_cmk" {
  statement {
    sid    = "RootAccountAdmin"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # The web + worker services may envelope-encrypt and decrypt safeguarding
  # fields and ProviderEvent attachments via this key.
  statement {
    sid    = "RailwayServiceUse"
    effect = "Allow"

    principals {
      type = "AWS"
      identifiers = [
        var.railway_web_principal_arn,
        var.railway_worker_principal_arn,
      ]
    }

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKeyWithoutPlaintext",
      "kms:ReEncrypt*",
      "kms:DescribeKey",
    ]
    resources = ["*"]
  }

  # Break-glass DSL principal: Decrypt only. Every break-glass use is paged
  # via the application audit pipeline (CLAUDE.md §21.1).
  statement {
    sid    = "BreakGlassDecrypt"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = [var.break_glass_dsl_principal_arn]
    }

    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "crm" {
  description             = "StudyMind CRM CMK (${var.env})"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  multi_region            = local.is_prod
  policy                  = data.aws_iam_policy_document.crm_cmk.json
}

resource "aws_kms_alias" "crm" {
  name          = local.cmk_alias
  target_key_id = aws_kms_key.crm.key_id
}

# Production: replica key in eu-west-1 so cross-region S3 replication can
# decrypt + re-encrypt under a regional key.
resource "aws_kms_replica_key" "crm" {
  count                   = local.is_prod ? 1 : 0
  provider                = aws.replica
  description             = "StudyMind CRM CMK replica (${var.env})"
  deletion_window_in_days = 30
  primary_key_arn         = aws_kms_key.crm.arn
  policy                  = data.aws_iam_policy_document.crm_cmk.json
}

resource "aws_kms_alias" "crm_replica" {
  count         = local.is_prod ? 1 : 0
  provider      = aws.replica
  name          = local.cmk_alias
  target_key_id = aws_kms_replica_key.crm[0].key_id
}

output "kms_key_id" {
  value       = aws_kms_key.crm.key_id
  description = "Primary CMK id (set as AWS_KMS_KEY_ID in Railway)."
}

output "kms_key_arn" {
  value = aws_kms_key.crm.arn
}

output "kms_replica_key_arn" {
  value = local.is_prod ? aws_kms_replica_key.crm[0].arn : null
}
