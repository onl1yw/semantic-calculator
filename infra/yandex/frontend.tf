resource "yandex_storage_bucket" "frontend" {
  depends_on            = [terraform_data.target]
  bucket                = "semantic-calculator-static-${var.folder_id}"
  folder_id             = var.folder_id
  default_storage_class = "STANDARD"
  max_size              = 64 * 1024 * 1024
  force_destroy         = false

  anonymous_access_flags {
    read        = false
    list        = false
    config_read = false
  }

  tags = local.labels

  lifecycle {
    prevent_destroy = true
  }
}

resource "yandex_storage_bucket_iam_binding" "frontend_read" {
  bucket  = yandex_storage_bucket.frontend.id
  role    = "storage.viewer"
  members = ["serviceAccount:${yandex_iam_service_account.gateway.id}"]
}
