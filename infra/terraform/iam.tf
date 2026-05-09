# IAM policies for the Railway services. Least privilege.

data "aws_iam_policy_document" "web_s3_access" {
  # The web service reads cost-reports + dsar (signed URLs) and writes new
  # DSAR exports.
  statement {
    sid    = "ReadDsarAndCostReports"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:ListBucket",
    ]
    resources = [
      aws_s3_bucket.this["cost_reports"].arn,
      "${aws_s3_bucket.this["cost_reports"].arn}/*",
      aws_s3_bucket.this["dsar"].arn,
      "${aws_s3_bucket.this["dsar"].arn}/*",
    ]
  }
  statement {
    sid    = "WriteDsarExports"
    effect = "Allow"
    actions = [
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.this["dsar"].arn}/*"]
  }
}

data "aws_iam_policy_document" "worker_s3_access" {
  # The worker writes to recordings, attachments, audit-archives, cost-reports,
  # and reads from all of the above for replay/repair flows.
  statement {
    sid    = "WriteAllOperationalBuckets"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:DeleteObject",
    ]
    resources = flatten([
      for k in ["recordings", "attachments", "audit_archives", "cost_reports", "backups"] : [
        aws_s3_bucket.this[k].arn,
        "${aws_s3_bucket.this[k].arn}/*",
      ]
    ])
  }
}

resource "aws_iam_policy" "web_s3" {
  name   = "${var.name_prefix}-${var.env}-web-s3"
  policy = data.aws_iam_policy_document.web_s3_access.json
}

resource "aws_iam_policy" "worker_s3" {
  name   = "${var.name_prefix}-${var.env}-worker-s3"
  policy = data.aws_iam_policy_document.worker_s3_access.json
}

# We attach to the Railway service principals via passthrough — the actual
# users/roles are owned outside Terraform (Railway long-lived access keys)
# and referenced by ARN. The attachments below assume the principals are
# IAM users in this account; if Railway moves to OIDC we'll switch to roles.
resource "aws_iam_user_policy_attachment" "web_s3" {
  user       = element(split("/", var.railway_web_principal_arn), length(split("/", var.railway_web_principal_arn)) - 1)
  policy_arn = aws_iam_policy.web_s3.arn
}

resource "aws_iam_user_policy_attachment" "worker_s3" {
  user       = element(split("/", var.railway_worker_principal_arn), length(split("/", var.railway_worker_principal_arn)) - 1)
  policy_arn = aws_iam_policy.worker_s3.arn
}
