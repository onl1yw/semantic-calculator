#!/usr/bin/env python3
"""Export the local table as gzip JSONL. Does not contact any cloud service."""
import argparse
import gzip
import json
from pathlib import Path
import sqlite3

import numpy as np

ROOT = Path(__file__).resolve().parent.parent

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=ROOT / "data" / "dictionary")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "dictionary-export.jsonl.gz")
    args = parser.parse_args()
    vectors = np.load(args.data / "vectors.npy", mmap_mode="r", allow_pickle=False)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    if args.output.exists():
        raise SystemExit("Output already exists; choose a new --output file")
    partial = args.output.with_name(args.output.name + ".part")
    with sqlite3.connect((args.data / "dictionary.sqlite3").resolve().as_uri() + "?mode=ro", uri=True) as db:
        with gzip.open(partial, "wt", encoding="utf-8") as target:
            for word, index in db.execute("SELECT word, row_index FROM words ORDER BY row_index"):
                target.write(json.dumps({"word": word, "vector": vectors[index].tolist()}, ensure_ascii=False, separators=(",", ":")) + "\n")
    partial.replace(args.output)
    print(f"Exported {len(vectors):,} records to {args.output}")
