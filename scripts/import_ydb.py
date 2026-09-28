"""Publish a verified immutable dictionary revision. Dry run unless --apply is set."""
import argparse
from dataclasses import replace
import json
from pathlib import Path
import time

import ydb

from backend.config import Settings
from backend.store import VectorStore
from backend.ydb_client import YdbConnection, utf8
from backend.ydb_schema import METADATA_TABLE, descriptor, schema_queries, table_names


ROW_TYPE = ydb.StructType().add_member("key", ydb.PrimitiveType.Utf8)
ROW_TYPE.add_member("word", ydb.PrimitiveType.Utf8)
ROW_TYPE.add_member("row_index", ydb.PrimitiveType.Uint32)
ROW_TYPE.add_member("vector", ydb.PrimitiveType.String)


def rows_for(store, lookup):
    for key, index in sorted(lookup.items()):
        yield {"key": key, "word": store.display_words[index], "row_index": index,
               "vector": store.vectors[index].astype("<f4", copy=False).tobytes()}


def batches(values, size=100):
    batch = []
    for item in values:
        batch.append(item)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def upload_table(connection, table, store, lookup, pause):
    query = ("DECLARE $rows AS List<Struct<key:Utf8,word:Utf8,row_index:Uint32,vector:String>>; "
             f"UPSERT INTO `{table}` SELECT key, word, row_index, vector FROM AS_TABLE($rows);")
    verify = (f"DECLARE $keys AS List<Utf8>; SELECT key, word, row_index, vector FROM `{table}` "
              "WHERE key IN $keys;")
    for number, batch in enumerate(batches(rows_for(store, lookup)), 1):
        connection.execute(query, {"$rows": (batch, ydb.ListType(ROW_TYPE))}, timeout=30, retries=8)
        time.sleep(pause)
        # Verify the actual server-returned bytes before publishing this revision.
        result = connection.execute(verify, {
            "$keys": ([row["key"] for row in batch], ydb.ListType(ydb.PrimitiveType.Utf8)),
        }, timeout=30, retries=8)
        actual = {row["key"]: dict(row) for row in result[0].rows}
        if actual != {row["key"]: row for row in batch}:
            raise RuntimeError("YDB import verification failed; revision remains unpublished")
        if number % 25 == 0:
            print(f"{table}: verified {min(number * 100, len(lookup))}/{len(lookup)} rows", flush=True)
        time.sleep(pause)
    result = connection.execute(f"SELECT COUNT(*) AS count FROM `{table}`;", timeout=30, retries=8)
    if result[0].rows[0]["count"] != len(lookup):
        raise RuntimeError("Unexpected table row count; revision remains unpublished")


def publish(connection, store, pause=.2):
    revision = store.metadata["model_revision"]
    identity = descriptor(store)
    for query in schema_queries(revision):
        connection.execute(query, timeout=30, retries=8)
    existing = connection.execute(
        f"DECLARE $revision AS Utf8; SELECT descriptor FROM `{METADATA_TABLE}` WHERE revision=$revision;",
        {"$revision": utf8(revision)}, timeout=30, retries=8,
    )[0].rows
    if existing:
        if existing[0]["descriptor"] != identity:
            raise RuntimeError("This revision was published with another descriptor")
        print("Revision already published; no data overwritten")
        return
    words, tokens = table_names(revision)
    upload_table(connection, words, store, store.lookup, pause)
    upload_table(connection, tokens, store, store.token_lookup, pause)
    # This is the last write. A failed or interrupted import cannot become usable.
    connection.execute(
        f"DECLARE $revision AS Utf8; DECLARE $descriptor AS Utf8; "
        f"INSERT INTO `{METADATA_TABLE}` (revision, descriptor) VALUES ($revision, $descriptor);",
        {"$revision": utf8(revision), "$descriptor": utf8(identity)}, timeout=30,
    )
    print("Published and verified", revision)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, default=Settings().data_dir)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    store = VectorStore(args.data, verify=True)
    print(json.dumps({**store.metadata, "tables": table_names(store.metadata["model_revision"]),
                      "plain_words": len(store.lookup), "tokens": len(store.token_lookup)}, indent=2))
    if not args.apply:
        return
    settings = replace(Settings.from_env(), data_dir=args.data, store_backend="ydb")
    connection = YdbConnection(settings)
    try:
        publish(connection, store)
    finally:
        connection.close()


if __name__ == "__main__":
    main()
