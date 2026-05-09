# S3 buckets. CLAUDE.md §3, §32, §46.2.
#
# Buckets:
#   - recordings        : Aircall recordings.
#   - attachments       : Email + Trengo attachments.
#   - dsar              : DSAR exports (operator downloads).
#   - cost-reports      : Weekly cost summary markdown.
#   - audit-archives    : Weekly NDJSON audit archive (CLAUDE.md §17.1, §21).
#   - backups           : Weekly logical Postgres dump.
#
# Versioning is on for every bucket. Production gets MFA-delete and CRR.

locals {
  buckets = {
    recordings     = "recordings"
    attachments    = "attachments"
    dsar           = "dsar"
    cost_reports   = "cost-reports"
    audit_archives = "audit-archives"
    backups        = "backups"
  }
}

resource "aws_s3_bucket" "this" {
  for_each = local.buckets
  bucket   = "${var.name_prefix}-${var.env}-${each.value}"
}

resource "aws_s3_bucket_versioning" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  versioning_configuration {
    status     = "Enabled"
    mfa_delete = local.is_prod ? "Enabled" : "Disabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  for_each = aws_s3_bucket.this
  bucket   = each.value.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.crm.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  for_each                = aws_s3_bucket.this
  bucket                  = each.value.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Lifecycle rules per CLAUDE.md §32:
#   - recordings: standard 0–30d → IA 31–90d → expire 91d.
#     The `retain=long` object tag overrides the expiry per-contract.
#   - attachments: standard 0–90d → Glacier afterwards.
#   - audit-archives: Glacier Deep Archive after 30d.
#   - cost-reports / dsar / backups: keep newest, no transition.
resource "aws_s3_bucket_lifecycle_configuration" "recordings" {
  bucket = aws_s3_bucket.this["recordings"].id

  rule {
    id     = "recordings-standard-then-expire"
    status = "Enabled"

    filter {
      tag {
        key   = "retain"
        value = "default"
      }
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    expiration {
      days = 91
    }
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }

  # Long-retain branch: tag-driven contracts keep their recordings.
  rule {
    id     = "recordings-long-retain"
    status = "Enabled"

    filter {
      tag {
        key   = "retain"
        value = "long"
      }
    }

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    transition {
      days          = 91
      storage_class = "GLACIER"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "attachments" {
  bucket = aws_s3_bucket.this["attachments"].id
  rule {
    id     = "attachments-standard-90-then-glacier"
    status = "Enabled"
    filter {}
    transition {
      days          = 90
      storage_class = "GLACIER"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "audit_archives" {
  bucket = aws_s3_bucket.this["audit_archives"].id
  rule {
    id     = "audit-archives-deep-archive-after-30d"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "DEEP_ARCHIVE"
    }
  }
}

# Cross-region replication for production. Replica buckets live in eu-west-1
# under the replica CMK.
resource "aws_s3_bucket" "replica" {
  for_each = local.is_prod ? aws_s3_bucket.this : {}
  provider = aws.replica
  bucket   = "${each.value.bucket}-replica"
}

resource "aws_s3_bucket_versioning" "replica" {
  for_each = aws_s3_bucket.replica
  provider = aws.replica
  bucket   = each.value.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_iam_role" "replication" {
  count              = local.is_prod ? 1 : 0
  name               = "${var.name_prefix}-${var.env}-s3-replication"
  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "s3.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_s3_bucket_replication_configuration" "this" {
  for_each = local.is_prod ? aws_s3_bucket.this : {}
  bucket   = each.value.id
  role     = aws_iam_role.replication[0].arn

  rule {
    id     = "${each.key}-to-replica"
    status = "Enabled"
    filter {}
    delete_marker_replication {
      status = "Enabled"
    }
    destination {
      bucket        = aws_s3_bucket.replica[each.key].arn
      storage_class = "STANDARD"
      encryption_configuration {
        replica_kms_key_id = aws_kms_replica_key.crm[0].arn
      }
    }
    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.this]
}

output "s3_bucket_names" {
  value = { for k, b in aws_s3_bucket.this : k => b.bucket }
}
