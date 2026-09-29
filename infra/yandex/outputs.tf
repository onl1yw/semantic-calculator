output "deployment" {
  value = {
    cloud_id            = var.cloud_id
    folder_id           = var.folder_id
    runtime_account_id  = yandex_iam_service_account.runtime.id
    gateway_account_id  = yandex_iam_service_account.gateway.id
    registry_id         = yandex_container_registry.application.id
    security_profile_id = yandex_sws_security_profile.application.id
    frontend_bucket     = yandex_storage_bucket.frontend.id
  }
}
