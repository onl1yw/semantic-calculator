"""YDB word lookup with an immutable local matrix for exact nearest search."""
from functools import lru_cache

import numpy as np

from .store import DIMENSIONS, VectorStore, clean_word
from .ydb_client import StoreUnavailable, YdbConnection, utf8
from .ydb_schema import METADATA_TABLE, descriptor, table_names


class YdbStore(VectorStore):
    def __init__(self, settings, connection=None):
        super().__init__(settings.data_dir, verify=True)
        self.connection = connection or YdbConnection(settings)
        self.words_table, self.tokens_table = table_names(self.metadata["model_revision"])
        try:
            result = self.connection.execute(
                f"DECLARE $revision AS Utf8; SELECT descriptor FROM `{METADATA_TABLE}` "
                "WHERE revision = $revision;",
                {"$revision": utf8(self.metadata["model_revision"])},
            )
            rows = result[0].rows
            if len(rows) != 1 or rows[0]["descriptor"] != descriptor(self):
                raise StoreUnavailable("Published YDB revision does not match the image snapshot")
        except Exception:
            self.connection.close()
            raise

    @lru_cache(maxsize=256)
    def suggest(self, prefix):
        key = clean_word(prefix)
        # Prefix is validated by the API. This upper bound also covers all Unicode suffixes.
        upper = key[:-1] + chr(ord(key[-1]) + 1)
        result = self.connection.execute(
            f"DECLARE $lower AS Utf8; DECLARE $upper AS Utf8; "
            f"SELECT word FROM `{self.words_table}` "
            "WHERE key >= $lower AND key < $upper ORDER BY key LIMIT 10;",
            {"$lower": utf8(key), "$upper": utf8(upper)},
        )
        return [row["word"] for row in result[0].rows]

    @lru_cache(maxsize=256)
    def vector(self, word):
        key = clean_word(word)
        # Plain lemmas take precedence, matching the local adapter's alias contract.
        table = self.words_table if key in self.lookup else self.tokens_table
        result = self.connection.execute(
            f"DECLARE $key AS Utf8; SELECT word, row_index, vector FROM `{table}` WHERE key = $key;",
            {"$key": utf8(key)},
        )
        rows = result[0].rows
        if not rows:
            return None
        row = rows[0]
        index = row["row_index"]
        vector = np.frombuffer(row["vector"], dtype="<f4")
        # Reject corrupt or mismatched data rather than combining different models.
        if (not 0 <= index < len(self.words) or vector.shape != (DIMENSIONS,)
                or row["word"] != self.display_words[index]
                or not np.array_equal(vector, self.vectors[index])):
            raise StoreUnavailable("Dictionary vector does not match the published snapshot")
        return {"word": row["word"], "vector": vector.tolist(), **self.metadata}

    def close(self):
        self.connection.close()
