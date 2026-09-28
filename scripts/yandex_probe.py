"""Check a healthy authenticated revision and denied direct public access."""
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent


def wait_for_scaling():
    # Yandex documents up to five minutes for the scaler to apply zone caps.
    # Keep the public gateway disconnected throughout this propagation window.
    print("Waiting 5 minutes for private revision scaling limits to propagate", flush=True)
    deadline = time.monotonic() + 300
    while (remaining := deadline - time.monotonic()) > 0:
        time.sleep(min(20, remaining))


def probe_private(container, yc):
    base = container["url"]
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != "https" or not (parsed.hostname or "").endswith(".containers.yandexcloud.net"):
        raise RuntimeError("Unexpected container invocation URL")
    url = base.rstrip("/") + "/api/health"
    token = subprocess.run([yc, "iam", "create-token", "--retry", "0"], check=True,
                           capture_output=True, text=True, timeout=30).stdout.strip()
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token})
    health = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                health = json.load(response)
            break
        except (urllib.error.URLError, TimeoutError):
            time.sleep(1)
    if not health or health.get("status") != "ok":
        raise RuntimeError("Private container did not become healthy; gateway stays disconnected")
    expected = json.loads((ROOT / "data/dictionary-word2vec-nouns/manifest.json").read_text())
    if any(health.get(key) != expected[key] for key in ("model_revision", "model_id", "count", "dimensions")):
        raise RuntimeError("Private container serves an unexpected dictionary revision")
    try:
        urllib.request.urlopen(url, timeout=10).close()
    except urllib.error.HTTPError as error:
        if error.code in {401, 403}:
            return
        raise RuntimeError("Direct public access denial was not confirmed") from None
    raise RuntimeError("Direct container invocation is public; gateway stays disconnected")
