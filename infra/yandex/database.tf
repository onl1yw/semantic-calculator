resource "yandex_ydb_database_serverless" "dictionary" {
  depends_on          = [terraform_data.target]
  name                = "semantic-calculator-dictionary"
  folder_id           = var.folder_id
  labels              = local.labels
  deletion_protection = true

  serverless_database {
    enable_throttling_rcu_limit = true
    throttling_rcu_limit        = 10
    provisioned_rcu_limit       = 0
    storage_size_limit          = 1
  }

  lifecycle {
    precondition {
      condition     = data.yandex_resourcemanager_folder.project.name == "semantic-calculator"
      error_message = "Database must be created in the dedicated project folder."
    }
    prevent_destroy = true
  }
}

resource "yandex_ydb_database_iam_binding" "runtime" {
  database_id = yandex_ydb_database_serverless.dictionary.id
  role        = "ydb.viewer"
  members     = ["serviceAccount:${yandex_iam_service_account.runtime.id}"]
}
