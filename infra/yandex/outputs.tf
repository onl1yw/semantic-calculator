output "deployment" {
  value = {
    cloud_id            = var.cloud_id
    folder_id           = var.folder_id
    database_id         = yandex_ydb_database_serverless.dictionary.id
    ydb_endpoint        = yandex_ydb_database_serverless.dictionary.ydb_api_endpoint
    ydb_database        = yandex_ydb_database_serverless.dictionary.database_path
    runtime_account_id  = yandex_iam_service_account.runtime.id
    gateway_account_id  = yandex_iam_service_account.gateway.id
    registry_id         = yandex_container_registry.application.id
    security_profile_id = yandex_sws_security_profile.application.id
  }
}
