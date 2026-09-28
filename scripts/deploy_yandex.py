"""Release a private, bounded container before connecting its protected gateway."""
import argparse
import json
from pathlib import Path
import re
import shlex
import shutil
import subprocess

from scripts.yandex_gateway import gateway_spec
from scripts.yandex_probe import probe_private, wait_for_scaling

ROOT = Path(__file__).resolve().parent.parent
NAME = "semantic-calculator"


def has_public_bindings(bindings):
    # YC represents public access as subject type "system", id "allUsers".
    public = {"allUsers", "allAuthenticatedUsers"}
    return any(item.get("subject", {}).get("id") in public or
               item.get("subject", {}).get("type") in public for item in bindings)


def revision_command(container_id, deployment, image):
    environment = {
        "SC_VERIFY_DICTIONARY": "true",
        "SC_SEARCH_CONCURRENCY": "2", "SC_SEARCH_TIMEOUT": "2",
        "SC_GLOBAL_PER_MINUTE": "240", "SC_GLOBAL_BURST": "10",
        "SC_GLOBAL_SEARCH_PER_MINUTE": "60", "SC_GLOBAL_SEARCH_BURST": "2",
    }
    return [
        "serverless", "container", "revision", "deploy", "--container-id", container_id,
        "--image", image, "--memory", "256MB", "--cores", "1", "--core-fraction", "20",
        "--execution-timeout", "3s", "--concurrency", "4", "--min-instances", "0",
        "--zone-instances-limit", "1", "--zone-requests-limit", "4", "--no-logging",
        "--service-account-id", deployment["runtime_account_id"],
        "--environment", ",".join(f"{key}={value}" for key, value in environment.items()),
    ]


def verify_revision(revision):
    limits = revision.get("scaling_policy", {})
    provision = revision.get("provision_policy", {})
    resources = revision.get("resources", {})
    environment = revision.get("image", {}).get("environment", {})
    checks = [revision.get("status") == "ACTIVE",
              int(limits.get("zone_instances_limit", 0)) == 1,
              int(limits.get("zone_requests_limit", 0)) == 4,
              int(provision.get("min_instances", 0)) == 0,
              int(revision.get("concurrency", 0)) == 4,
              0 < int(resources.get("memory", 0)) <= 256 * 1024 * 1024,
              int(resources.get("cores", 0)) == 1,
              int(resources.get("core_fraction", 0)) == 20,
              revision.get("execution_timeout") == "3s",
              environment.get("SC_VERIFY_DICTIONARY") == "true",
              not any("YDB" in name or name == "SC_STORE_BACKEND" for name in environment)]
    if not all(checks):
        raise RuntimeError("Revision limits or local dictionary settings were not confirmed; gateway will not be connected")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--foundation", type=Path, required=True,
                        help="terraform output -json deployment saved to a local file")
    parser.add_argument("--image", required=True, help="Immutable registry image URL with @sha256 digest")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    deployment = json.loads(args.foundation.read_text())
    if not re.fullmatch(r"cr\.yandex/" + re.escape(deployment["registry_id"]) +
                        r"/[a-z0-9/_-]+@sha256:[a-f0-9]{64}", args.image):
        parser.error("Use a digest-pinned image from the project's registry")
    if not args.apply:
        print(shlex.join(["yc", *revision_command("CONTAINER_ID", deployment, args.image),
                          "--folder-id", deployment["folder_id"]]))
        print("Container stays private; gateway is connected only after revision limits are verified.")
        return
    yc = shutil.which("yc") or str(Path.home() / "yandex-cloud/bin/yc")

    def call(*command):
        result = subprocess.run([yc, *command, "--folder-id", deployment["folder_id"],
                                 "--cloud-id", deployment["cloud_id"], "--format", "json"],
                                check=True, text=True, capture_output=True)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    folder = call("resource-manager", "folder", "get", deployment["folder_id"])
    if folder["name"] != NAME or folder["cloud_id"] != deployment["cloud_id"]:
        raise RuntimeError("Release target must be the dedicated project folder")
    for kind, identifier in (("cloud", deployment["cloud_id"]), ("folder", deployment["folder_id"])):
        bindings = call("resource-manager", kind, "list-access-bindings", identifier)
        if has_public_bindings(bindings):
            raise RuntimeError("Project inherits public cloud/folder rights; review IAM first")
    containers = call("serverless", "container", "list")
    container = next((item for item in containers if item["name"] == NAME), None)
    if container is None:
        container = call("serverless", "container", "create", "--name", NAME)
    identifier = container["id"]
    bindings = call("serverless", "container", "list-access-bindings", "--id", identifier)
    if has_public_bindings(bindings):
        raise RuntimeError("Container has public invocation rights; review IAM first")
    gateway_subject = "serviceAccount:" + deployment["gateway_account_id"]
    if any(item["subject"]["id"] == deployment["gateway_account_id"] and
           item["role_id"] == "serverless-containers.containerInvoker" for item in bindings):
        call("serverless", "container", "remove-access-binding", "--id", identifier,
             "--role", "serverless-containers.containerInvoker", "--subject", gateway_subject)
    revision = call(*revision_command(identifier, deployment, args.image))
    confirmed = call("serverless", "container", "revision", "get", revision["id"])
    verify_revision(confirmed)
    wait_for_scaling()
    probe_private(container, yc)
    call("serverless", "container", "add-access-binding", "--id", identifier,
         "--role", "serverless-containers.containerInvoker",
         "--subject", gateway_subject)
    output = ROOT / "output/deployment"
    output.mkdir(parents=True, exist_ok=True)
    spec = output / "gateway.json"
    spec.write_text(json.dumps(gateway_spec(identifier, deployment["gateway_account_id"],
                                          deployment["security_profile_id"]), indent=2))
    gateways = call("serverless", "api-gateway", "list")
    existing = next((item for item in gateways if item["name"] == NAME), None)
    command = ["serverless", "api-gateway", "update" if existing else "create"]
    command += ["--id", existing["id"]] if existing else ["--name", NAME]
    # Startup can exceed the container's request execution limit; allow the
    # gateway to wait for a cold instance while keeping container compute at 3s.
    result = call(*command, "--spec", str(spec), "--execution-timeout", "10s", "--no-logging")
    print(json.dumps({"container_id": identifier, "revision_id": confirmed["id"],
                      "gateway_id": result["id"], "domain": result.get("domain")}, indent=2))


if __name__ == "__main__":
    main()
