#!/usr/bin/env python3
"""Prepare the official GeoWAC dictionary without loading its subword model."""
import argparse
from hashlib import sha256
import io
import json
from pathlib import Path
import pickle
import shutil
import sqlite3
import subprocess
import tempfile
import zipfile

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = "geowac_lemmas_none_fasttextskipgram_300_5_2020"
SOURCE_URL = "https://vectors.nlpl.eu/repository/20/213.zip"
EXPECTED_COUNT, DIMENSIONS = 154923, 300


class LegacyRecord:
    """Inert container for the two data classes in the Gensim 3.8 vocabulary."""


class VocabularyReader(pickle.Unpickler):
    def find_class(self, module, name):
        # Never import Gensim or execute constructors from an arbitrary pickle.
        if module == "gensim.models.keyedvectors" and name in {"Vocab", "FastTextKeyedVectors"}:
            return LegacyRecord
        raise pickle.UnpicklingError(f"Unexpected vocabulary class: {module}.{name}")


def digest(path):
    with path.open("rb") as stream:
        return sha256_stream(stream)


def sha256_stream(stream):
    value = sha256()
    while chunk := stream.read(4 * 1024 * 1024):
        value.update(chunk)
    return value.hexdigest()


def download(archive):
    if archive.is_file() and zipfile.is_zipfile(archive):
        print("Using downloaded archive", flush=True)
        return
    archive.parent.mkdir(parents=True, exist_ok=True)
    partial = archive.with_suffix(".zip.part")
    subprocess.run(["curl", "--fail", "--location", "--retry", "3", "--retry-delay", "3",
                    "--continue-at", "-", "--output", str(partial), SOURCE_URL], check=True)
    if not zipfile.is_zipfile(partial):
        raise ValueError("The downloaded file is not a complete ZIP archive")
    partial.replace(archive)


def prepare(archive, output):
    print("Hashing source archive…", flush=True)
    source_hash = digest(archive)
    revision = "sha256:" + sha256((source_hash + ":l2-float32-v1").encode()).hexdigest()
    if output.exists():
        manifest = json.loads((output / "manifest.json").read_text())
        if manifest["model_revision"] != revision:
            raise ValueError("Output contains another revision; choose a new --output directory")
        for name, expected in manifest["files_sha256"].items():
            if digest(output / name) != expected:
                raise ValueError(f"Prepared file failed integrity check: {name}")
        print("Prepared dictionary is already present and its hashes match", flush=True)
        return manifest

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="preparing-", dir=output.parent) as temporary:
        staging = Path(temporary)
        with zipfile.ZipFile(archive) as zipped:
            meta = json.loads(zipped.read("meta.json"))
            if meta["id"] != 213 or meta["dimensions"] != DIMENSIONS or meta["vocabulary size"] != EXPECTED_COUNT:
                raise ValueError("Archive is not the requested GeoWAC model")
            model = VocabularyReader(io.BytesIO(zipped.read("model.model"))).load()
            words = model.index2word
            if (len(words) != EXPECTED_COUNT or len(set(words)) != EXPECTED_COUNT
                    or not all(isinstance(word, str) and word for word in words)
                    or any(model.vocab[word].index != i for i, word in enumerate(words))):
                raise ValueError("Vocabulary and vector indices do not match")
            (staging / "words.json").write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
            (staging / "source-meta.json").write_bytes(zipped.read("meta.json"))
            (staging / "source-README.txt").write_bytes(zipped.read("README"))
            print("Extracting the existing word vectors (subwords are not needed)…", flush=True)
            with zipped.open("model.model.vectors.npy") as source, (staging / "raw_vectors.npy").open("wb") as target:
                shutil.copyfileobj(source, target, length=4 * 1024 * 1024)

        raw = np.load(staging / "raw_vectors.npy", mmap_mode="r", allow_pickle=False)
        if raw.dtype != np.float32 or raw.shape != (EXPECTED_COUNT, DIMENSIONS):
            raise ValueError("Unexpected vector matrix")
        normalized = np.lib.format.open_memmap(staging / "vectors.npy", mode="w+",
                                               dtype=np.float32, shape=raw.shape)
        print("Normalizing vectors and building the local SQLite table…", flush=True)
        with sqlite3.connect(staging / "dictionary.sqlite3") as database:
            database.execute("CREATE TABLE words (word TEXT PRIMARY KEY, row_index INTEGER NOT NULL UNIQUE, vector BLOB NOT NULL CHECK(length(vector) = 1200))")
            database.execute("CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            for start in range(0, len(words), 2048):
                stop = min(start + 2048, len(words))
                block = np.asarray(raw[start:stop], dtype=np.float64)
                norms = np.linalg.norm(block, axis=1)
                if not np.isfinite(block).all() or not np.isfinite(norms).all() or (norms == 0).any():
                    raise ValueError("The source contains a zero or non-finite vector")
                normalized[start:stop] = block / norms[:, None]
                database.executemany("INSERT INTO words VALUES (?, ?, ?)",
                                     ((words[i], i, raw[i].astype("<f4", copy=False).tobytes())
                                      for i in range(start, stop)))
            database.executemany("INSERT INTO metadata VALUES (?, ?)",
                                 [("model_id", MODEL_ID), ("model_revision", revision),
                                  ("dimensions", str(DIMENSIONS)), ("source_sha256", source_hash)])
            if database.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("SQLite integrity check failed")
        normalized.flush()
        del normalized, raw
        manifest = {"schema_version": 1, "model_id": MODEL_ID, "model_revision": revision,
                    "count": EXPECTED_COUNT, "dimensions": DIMENSIONS, "dtype": "float32",
                    "normalization": "L2", "source_url": SOURCE_URL, "source_sha256": source_hash,
                    "attribution": "RusVectōrēs / NLPL; Andrey Kutuzov; GeoWAC by Jonathan Dunn and Ben Adams",
                    "license_catalog_url": "https://rusvectores.org/ru/models/", "license": "CC BY",
                    "files_sha256": {name: digest(staging / name) for name in
                                     ("words.json", "raw_vectors.npy", "vectors.npy", "dictionary.sqlite3")}}
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        staging.rename(output)
    print(f"Ready: {manifest['count']:,} words × {DIMENSIONS} dimensions in {output}", flush=True)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=ROOT / "models" / f"{MODEL_ID}.zip")
    parser.add_argument("--output", type=Path, default=ROOT / "data" / "dictionary")
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args()
    if not args.skip_download:
        download(args.archive)
    prepare(args.archive, args.output)
