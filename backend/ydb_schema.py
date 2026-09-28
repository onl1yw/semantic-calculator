"""Revision-specific names and publication identity shared by import and runtime."""
from hashlib import sha256
import json

METADATA_TABLE = "dictionary_revisions"


def table_names(revision):
    # No caller-supplied SQL identifier is interpolated into queries.
    prefix = "dictionary_" + sha256(revision.encode()).hexdigest()[:20]
    return prefix + "_words", prefix + "_tokens"


def descriptor(store):
    manifest = store.manifest
    return json.dumps({
        **store.metadata,
        "words_sha256": manifest["files_sha256"]["words.json"],
        "vectors_sha256": manifest["files_sha256"]["vectors.npy"],
    }, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def schema_queries(revision):
    words, tokens = table_names(revision)
    return [
        f"""CREATE TABLE IF NOT EXISTS `{METADATA_TABLE}` (
            revision Utf8 NOT NULL, descriptor Utf8 NOT NULL,
            PRIMARY KEY (revision));""",
        *[f"""CREATE TABLE IF NOT EXISTS `{table}` (
            key Utf8 NOT NULL, word Utf8 NOT NULL,
            row_index Uint32 NOT NULL, vector String NOT NULL,
            PRIMARY KEY (key));""" for table in (words, tokens)],
    ]
