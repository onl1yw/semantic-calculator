terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    yandex = {
      source  = "yandex-cloud/yandex"
      version = "0.230.0"
    }
  }
}

provider "yandex" {
  cloud_id  = var.cloud_id
  folder_id = var.folder_id
}

data "yandex_resourcemanager_folder" "project" {
  folder_id = var.folder_id
}

resource "terraform_data" "target" {
  input = var.folder_id
  lifecycle {
    precondition {
      condition = (
        data.yandex_resourcemanager_folder.project.name == "semantic-calculator" &&
        data.yandex_resourcemanager_folder.project.cloud_id == var.cloud_id
      )
      error_message = "Use the project's dedicated semantic-calculator folder."
    }
  }
}
