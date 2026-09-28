#!/usr/bin/env python3
"""Prepare a RusVectores dictionary without loading training or subword weights."""
import argparse
from hashlib import sha256
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import zipfile

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODEL_ID = "ruwikiruscorpora_upos_skipgram_300_2_2019"
SOURCE_URL = "https://vectors.nlpl.eu/repository/20/182.zip"
SOURCE_COUNT, DIMENSIONS = 248978, 300
DATA_DIR = ROOT / "data" / "dictionary-word2vec-nouns"
ATTRIBUTION = "RusVectōrēs / NLPL; Andrey Kutuzov; Russian National Corpus and Russian Wikipedia"


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


def read_word2vec(stream, output, expected_count):
    """Read the standard binary format as data, including UTF-8 word tokens."""
    header = stream.readline(128).split()
    if header != [str(expected_count).encode(), str(DIMENSIONS).encode()]:
        raise ValueError("Unexpected word2vec matrix header")
    raw = np.lib.format.open_memmap(output, mode="w+", dtype=np.float32,
                                  shape=(expected_count, DIMENSIONS))
    words = []
    for index in range(expected_count):
        token = bytearray()
        while True:
            char = stream.read(1)
            if not char:
                raise ValueError("Truncated word2vec token")
            if not token and char in (b"\n", b"\r"):
                continue
            if char == b" ":
                break
            token.extend(char)
            if len(token) > 4096:
                raise ValueError("Oversized word2vec token")
        word = token.decode("utf-8")
        if not word or any(char.isspace() for char in word):
            raise ValueError("Invalid word2vec token")
        values = stream.read(DIMENSIONS * 4)
        if len(values) != DIMENSIONS * 4:
            raise ValueError("Truncated word2vec vector")
        raw[index] = np.frombuffer(values, dtype="<f4")
        words.append(word)
    if stream.read().strip():
        raise ValueError("Unexpected trailing word2vec data")
    if len(set(words)) != expected_count:
        raise ValueError("Duplicate word2vec tokens")
    raw.flush()
    del raw
    return words


def prepare(archive, output):
    expected_count = SOURCE_COUNT
    print("Hashing source archive…", flush=True)
    source_hash = digest(archive)
    transformation = ":l2-float32-v1:pos=NOUN"
    revision = "sha256:" + sha256((source_hash + transformation).encode()).hexdigest()
    if output.exists():
        manifest = json.loads((output / "manifest.json").read_text())
        if manifest["model_revision"] != revision or manifest["model_id"] != MODEL_ID:
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
            if (meta["id"] != 182 or meta["dimensions"] != DIMENSIONS
                    or meta["vocabulary size"] != expected_count):
                raise ValueError("Archive is not the requested model")
            print("Reading the existing word2vec matrix…", flush=True)
            with zipped.open("model.bin") as source:
                words = read_word2vec(io.BufferedReader(source), staging / "raw_vectors.npy", expected_count)
            (staging / "source-meta.json").write_bytes(zipped.read("meta.json"))
            (staging / "source-README.txt").write_bytes(zipped.read("README"))

        raw = np.load(staging / "raw_vectors.npy", mmap_mode="r", allow_pickle=False)
        if raw.dtype != np.float32 or raw.shape != (expected_count, DIMENSIONS):
            raise ValueError("Unexpected vector matrix")
        indices = np.array([i for i, word in enumerate(words) if word.rpartition("_")[2] == "NOUN"])
        if not len(indices):
            raise ValueError("No noun tokens in the source model")
        filtered_path = staging / "filtered_vectors.npy"
        filtered = np.lib.format.open_memmap(filtered_path, mode="w+", dtype=np.float32,
                                             shape=(len(indices), DIMENSIONS))
        for start in range(0, len(indices), 2048):
            filtered[start:start + 2048] = raw[indices[start:start + 2048]]
        filtered.flush()
        del filtered, raw
        filtered_path.replace(staging / "raw_vectors.npy")
        words = [words[i] for i in indices]
        raw = np.load(staging / "raw_vectors.npy", mmap_mode="r", allow_pickle=False)
        print(f"Keeping {len(words):,} NOUN tokens", flush=True)
        (staging / "words.json").write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
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
                    "count": len(words), "source_count": expected_count,
                    "dimensions": DIMENSIONS, "dtype": "float32",
                    "normalization": "L2", "tagset": "UPoS", "pos_filter": "NOUN",
                    "source_url": SOURCE_URL, "source_sha256": source_hash,
                    "attribution": ATTRIBUTION,
                    "license_catalog_url": "https://rusvectores.org/ru/models/", "license": "CC BY",
                    "files_sha256": {name: digest(staging / name) for name in
                                     ("words.json", "raw_vectors.npy", "vectors.npy", "dictionary.sqlite3")}}
        (staging / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        staging.rename(output)
    print(f"Ready: {manifest['count']:,} words × {DIMENSIONS} dimensions in {output}", flush=True)
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--skip-download", action="store_true")
    args = parser.parse_args()
    archive = args.archive or ROOT / "models" / f"{MODEL_ID}.zip"
    output = args.output or DATA_DIR
    if not args.skip_download:
        download(archive)
    prepare(archive, output)
