resource "yandex_iam_service_account" "runtime" {
  depends_on  = [terraform_data.target]
  name        = "semantic-calculator-runtime"
  folder_id   = var.folder_id
  description = "Pulls the application image; dictionary is bundled locally."
}

resource "yandex_iam_service_account" "gateway" {
  depends_on  = [terraform_data.target]
  name        = "semantic-calculator-gateway"
  folder_id   = var.folder_id
  description = "Invokes only the application container; binding added at release."
}

resource "yandex_container_registry" "application" {
  depends_on = [terraform_data.target]
  name       = "semantic-calculator"
  folder_id  = var.folder_id
  labels     = local.labels
}

resource "yandex_container_registry_iam_binding" "runtime_pull" {
  registry_id = yandex_container_registry.application.id
  role        = "container-registry.images.puller"
  members     = ["serviceAccount:${yandex_iam_service_account.runtime.id}"]
}
