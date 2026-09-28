variable "cloud_id" {
  type        = string
  description = "Cloud containing the dedicated project folder."
}

variable "folder_id" {
  type        = string
  description = "Existing semantic-calculator folder; never the shared default folder."
}

locals {
  labels = { project = "semantic-calculator" }
}
