"""Run this project's isolated Terraform state with a short-lived YC token."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("init", "fmt", "validate", "plan", "apply", "output"))
    parser.add_argument("--cloud-id", default=os.environ.get("SC_YC_CLOUD_ID"))
    parser.add_argument("--folder-id", default=os.environ.get("SC_YC_FOLDER_ID"))
    args, extra = parser.parse_known_args()
    terraform = shutil.which("terraform") or str(ROOT / "output/tools/terraform")
    environment = os.environ.copy()
    environment["TF_CLI_CONFIG_FILE"] = str(ROOT / "infra/yandex/terraform.rc")
    if args.command in {"plan", "apply"}:
        if not args.cloud_id or not args.folder_id:
            parser.error("Provide --cloud-id and --folder-id for this project")
        environment["TF_VAR_cloud_id"] = args.cloud_id
        environment["TF_VAR_folder_id"] = args.folder_id
        if not environment.get("YC_TOKEN"):
            yc = shutil.which("yc") or str(Path.home() / "yandex-cloud/bin/yc")
            token = subprocess.run([yc, "iam", "create-token"], check=True,
                                   capture_output=True, text=True).stdout.strip()
            if not token:
                raise RuntimeError("YC did not return an IAM token")
            environment["YC_TOKEN"] = token
        # SDK debug logging can include authentication headers.
        environment.pop("TF_LOG", None)
        environment.pop("TF_LOG_PROVIDER", None)
    command = [terraform, "-chdir=" + str(ROOT / "infra/yandex"), args.command, *extra]
    raise SystemExit(subprocess.run(command, env=environment).returncode)


if __name__ == "__main__":
    main()
