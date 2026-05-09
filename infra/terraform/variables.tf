variable "env" {
  type        = string
  description = "Deployment environment: prod | staging | dev."
  validation {
    condition     = contains(["prod", "staging", "dev"], var.env)
    error_message = "env must be prod, staging or dev."
  }
}

variable "region" {
  type        = string
  description = "Primary AWS region for the environment."
  default     = "eu-west-2"
}

variable "name_prefix" {
  type        = string
  description = "Bucket + key name prefix."
  default     = "studymind-crm"
}

# Railway IAM user/role ARNs that own the application identity. The Railway
# services authenticate to AWS via long-lived IAM access keys today; OIDC
# federation is tracked in docs/adr/ for follow-up.
variable "railway_web_principal_arn" {
  type        = string
  description = "IAM principal ARN used by the Railway 'web' service."
}

variable "railway_worker_principal_arn" {
  type        = string
  description = "IAM principal ARN used by the Railway 'worker' service."
}

variable "break_glass_dsl_principal_arn" {
  type        = string
  description = "IAM principal ARN used by the on-call DSL break-glass role. CLAUDE.md §21.1."
}
