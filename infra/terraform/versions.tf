terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.50"
    }
  }

  # State is held in S3 with a DynamoDB lock table. The bucket and table
  # must be bootstrapped manually before the first apply (see README).
  backend "s3" {
    bucket         = "studymind-crm-tfstate"
    key            = "crm/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "studymind-crm-tfstate-lock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project   = "studymind-crm"
      ManagedBy = "terraform"
      Env       = var.env
    }
  }
}

# Multi-region replica provider for the production CMK + cross-region S3
# replication. Aliased; only referenced in production-only resources.
provider "aws" {
  alias  = "replica"
  region = "eu-west-1"
  default_tags {
    tags = {
      Project   = "studymind-crm"
      ManagedBy = "terraform"
      Env       = var.env
    }
  }
}
