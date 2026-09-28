#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f data/dictionary/manifest.json ]]; then
  echo "Prepare the model first: .venv/bin/python scripts/prepare_model.py"
  exit 1
fi
if [[ ! -d frontend/dist ]]; then
  (cd frontend && npm run build)
fi
export OPENBLAS_NUM_THREADS=1
export VECLIB_MAXIMUM_THREADS=1
exec .venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port "${SC_PORT:-8000}" \
  --workers 1 --no-access-log --no-proxy-headers --timeout-keep-alive 5 \
  --limit-concurrency 64 --backlog 64
