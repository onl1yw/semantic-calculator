# Every path is bounded, including unknown paths and frontend assets.
# ARL rules are ordered from specific expensive requests to the catch-all.
resource "yandex_sws_advanced_rate_limiter_profile" "application" {
  depends_on = [terraform_data.target]
  name       = "semantic-calculator-limits"
  folder_id  = var.folder_id
  labels     = local.labels

  advanced_rate_limiter_rule {
    name     = "nearest"
    priority = 10
    dry_run  = false
    static_quota {
      action = "DENY"
      limit  = 30
      period = 60
      condition {
        request_uri {
          path { exact_match = "/api/nearest" }
        }
      }
    }
  }

  advanced_rate_limiter_rule {
    name     = "dictionary-api"
    priority = 20
    dry_run  = false
    static_quota {
      action = "DENY"
      limit  = 120
      period = 60
      condition {
        request_uri {
          path { prefix_match = "/api/" }
        }
      }
    }
  }

  advanced_rate_limiter_rule {
    name     = "all-traffic"
    priority = 100
    dry_run  = false
    static_quota {
      action = "DENY"
      limit  = 600
      period = 60
    }
  }
}

resource "yandex_sws_security_profile" "application" {
  name                             = "semantic-calculator-protection"
  folder_id                        = var.folder_id
  labels                           = local.labels
  default_action                   = "ALLOW"
  disallow_data_processing         = true
  advanced_rate_limiter_profile_id = yandex_sws_advanced_rate_limiter_profile.application.id

  security_rule {
    name     = "smart-protection"
    priority = 100
    dry_run  = false
    smart_protection { mode = "API" }
  }
}
