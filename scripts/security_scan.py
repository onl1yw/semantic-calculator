"""Scan publishable files and Git history using a checksummed Gitleaks binary."""
from hashlib import sha256
import io
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
VERSION = "8.30.1"
CHECKSUMS = {
    "darwin_arm64": "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
    "darwin_x64": "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    "linux_arm64": "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
    "linux_x64": "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
}


def binary():
    system = platform.system().lower()
    arch = "arm64" if platform.machine() in {"arm64", "aarch64"} else "x64"
    target = f"{system}_{arch}"
    if target not in CHECKSUMS:
        raise RuntimeError("Use a supported macOS or Linux system for this scanner")
    destination = ROOT / "output/security-tools" / ("gitleaks-" + VERSION)
    if destination.exists():
        # Verify extracted bytes against the archive on each invocation.
        destination.unlink()
    url = f"https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/gitleaks_{VERSION}_{target}.tar.gz"
    archive = urllib.request.urlopen(url, timeout=30).read()
    if sha256(archive).hexdigest() != CHECKSUMS[target]:
        raise RuntimeError("Gitleaks download checksum mismatch")
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as source:
        content = source.extractfile("gitleaks").read()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
    destination.chmod(0o755)
    return destination


def main():
    scanner = str(binary())
    flags = ["--redact", "--no-banner", "--log-level", "warn"]
    subprocess.run([scanner, "git", str(ROOT), *flags], check=True)
    # Include untracked code but exclude everything already excluded by .gitignore.
    names = subprocess.check_output(["git", "ls-files", "--cached", "--others",
                                     "--exclude-standard", "-z"], cwd=ROOT).decode().split("\0")
    with tempfile.TemporaryDirectory(prefix="semantic-public-scan-") as staging:
        for name in names:
            source = ROOT / name
            if name and source.is_file():
                target = Path(staging) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
        subprocess.run([scanner, "dir", staging, *flags], check=True)
    print("Git history and publishable working files: no secrets detected")


if __name__ == "__main__":
    main()
