"""Publish static frontend files and update the gateway without restarting the API."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

from scripts.yandex_gateway import gateway_spec

ROOT = Path(__file__).resolve().parent.parent
NAME = "semantic-calculator"
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
    ".woff": "font/woff", ".woff2": "font/woff2",
}


def frontend_files(dist):
    dist = dist.resolve()
    files = {name: dist / name for name in ("index.html", "card.png", "favicon.svg")}
    for path in sorted((dist / "assets").rglob("*")):
        if path.is_file() and path.suffix in CONTENT_TYPES:
            files[path.relative_to(dist).as_posix()] = path
    files.update({name: ROOT / name for name in ("LICENSE", "NOTICE")})
    for name, path in files.items():
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 3 * 1024 * 1024:
            raise ValueError(f"Missing, oversized or linked frontend file: {name}")
        expected_root = ROOT if name in {"LICENSE", "NOTICE"} else dist
        if not path.resolve().is_relative_to(expected_root):
            raise ValueError(f"Frontend file escapes its build directory: {name}")
    html = files["index.html"].read_text()
    if "/src/main.tsx" in html or not re.search(r'/assets/[^"\s]+\.js', html):
        raise ValueError("Build the production frontend before publishing")
    for asset in re.findall(r'(?:src|href)="(/assets/[^"?#]+)', html):
        if asset.lstrip("/") not in files:
            raise ValueError(f"HTML refers to a missing asset: {asset}")
    if sum(path.stat().st_size for path in files.values()) > 8 * 1024 * 1024:
        raise ValueError("Frontend release exceeds the 8 MiB publication limit")
    return files


def frontend_manifest(dist, bucket):
    files = frontend_files(dist)
    hashes = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}
    revision = hashlib.sha256(json.dumps(hashes, sort_keys=True).encode()).hexdigest()[:24]
    return {"bucket": bucket, "prefix": "releases/" + revision,
            "html": files["index.html"].read_text(), "sha256": hashes}


def publish_frontend(call, deployment, dist):
    bucket = deployment["frontend_bucket"]
    manifest = frontend_manifest(dist, bucket)
    details = call("storage", "bucket", "get", bucket)
    if details.get("folder_id") != deployment["folder_id"] or any(
            details.get("anonymous_access_flags", {}).values()):
        raise RuntimeError("Publish only to the project's private frontend bucket")
    for name, path in frontend_files(dist).items():
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != manifest["sha256"][name]:
            raise RuntimeError("Frontend build changed during publication")
        key = name if name.startswith("assets/") else manifest["prefix"] + "/" + name
        cache = "public, max-age=31536000, immutable" if name.startswith("assets/") else "no-cache"
        result = call("storage", "s3api", "put-object", "--bucket", bucket, "--key", key,
                      "--body", str(path), "--content-type", CONTENT_TYPES.get(path.suffix, "text/plain; charset=utf-8"),
                      "--cache-control", cache, "--content-md5",
                      base64.b64encode(hashlib.md5(content).digest()).decode())
        if result.get("etag", "").strip('"') != hashlib.md5(content).hexdigest():
            raise RuntimeError(f"Uploaded frontend checksum was not confirmed: {name}")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--foundation", type=Path, required=True)
    parser.add_argument("--dist", type=Path, default=ROOT / "frontend/dist")
    parser.add_argument("--output", type=Path, default=ROOT / "output/deployment/frontend.json")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    deployment = json.loads(args.foundation.read_text())
    manifest = frontend_manifest(args.dist, deployment["frontend_bucket"])
    if not args.apply:
        print(json.dumps({"bucket": manifest["bucket"], "prefix": manifest["prefix"],
                          "files": list(manifest["sha256"]), "container_restart": False}, indent=2))
        return
    yc = shutil.which("yc") or str(Path.home() / "yandex-cloud/bin/yc")

    def call(*command):
        result = subprocess.run([yc, *command, "--folder-id", deployment["folder_id"],
                                 "--cloud-id", deployment["cloud_id"], "--format", "json"],
                                check=True, capture_output=True, text=True, timeout=60)
        return json.loads(result.stdout) if result.stdout.strip() else {}

    from scripts.deploy_yandex import has_public_bindings, verify_revision
    folder = call("resource-manager", "folder", "get", deployment["folder_id"])
    if folder["name"] != NAME or folder["cloud_id"] != deployment["cloud_id"]:
        raise RuntimeError("Use the project's dedicated folder")
    for kind, identifier in (("cloud", deployment["cloud_id"]), ("folder", deployment["folder_id"])):
        if has_public_bindings(call("resource-manager", kind, "list-access-bindings", identifier)):
            raise RuntimeError("Review inherited public access before release")
    container = next(item for item in call("serverless", "container", "list") if item["name"] == NAME)
    if has_public_bindings(call("serverless", "container", "list-access-bindings", "--id", container["id"])):
        raise RuntimeError("The API container must remain private")
    active = next(item for item in call("serverless", "container", "revision", "list",
                                       "--container-id", container["id"]) if item["status"] == "ACTIVE")
    verify_revision(active)
    gateway = next(item for item in call("serverless", "api-gateway", "list") if item["name"] == NAME)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    before = call("serverless", "api-gateway", "get", gateway["id"])
    args.output.with_suffix(".gateway-before.json").write_text(json.dumps(before, indent=2))
    previous_spec = call("serverless", "api-gateway", "get-spec", gateway["id"])
    args.output.with_suffix(".previous-spec.json").write_text(previous_spec["openapi_spec"])
    manifest = publish_frontend(call, deployment, args.dist)
    spec = gateway_spec(container["id"], deployment["gateway_account_id"],
                        deployment["security_profile_id"], manifest)
    spec_path = args.output.with_suffix(".gateway.json")
    spec_path.write_text(json.dumps(spec, indent=2))
    result = call("serverless", "api-gateway", "update", "--id", gateway["id"],
                  "--spec", str(spec_path), "--execution-timeout", "10s", "--no-logging")
    release = {**manifest, "gateway_id": result["id"], "container_id": container["id"],
               "revision_id": active["id"]}
    args.output.write_text(json.dumps(release, indent=2))
    print(json.dumps({key: release[key] for key in ("gateway_id", "revision_id", "bucket", "prefix")}, indent=2))


if __name__ == "__main__":
    main()
