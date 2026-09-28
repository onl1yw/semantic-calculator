from dataclasses import replace
from hashlib import file_digest
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
import numpy as np
import pytest

from backend.app import create_app
from backend.config import Settings
from backend.store import VectorStore
from backend.ydb_client import StoreUnavailable
from backend.ydb_schema import descriptor, table_names
from backend.ydb_store import YdbStore


@pytest.fixture
def snapshot(tmp_path):
    words = ["печь_NOUN", "печь_VERB", "королева_NOUN"]
    np.save(tmp_path / "vectors.npy", np.eye(3, 300, dtype=np.float32))
    (tmp_path / "words.json").write_text(json.dumps(words))
    hashes = {}
    for name in ("words.json", "vectors.npy"):
        with (tmp_path / name).open("rb") as stream:
            hashes[name] = file_digest(stream, "sha256").hexdigest()
    (tmp_path / "manifest.json").write_text(json.dumps({
        "model_id": "test", "model_revision": "test-v1", "count": 3,
        "dimensions": 300, "tagset": "UPoS", "files_sha256": hashes,
    }))
    return VectorStore(tmp_path, verify=True)


class FakeConnection:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.identity = descriptor(snapshot)
        self.closed = False
        self.failed = False
        self.corrupt = False
        self.calls = []

    def execute(self, query, parameters):
        self.calls.append((query, parameters))
        if self.failed:
            raise StoreUnavailable("private endpoint and query details")
        if "SELECT descriptor" in query:
            rows = [{"descriptor": self.identity}] if self.identity else []
        elif "$lower" in parameters:
            lower, upper = parameters["$lower"][0], parameters["$upper"][0]
            rows = [{"word": word} for key, word in self.snapshot.prefix_index if lower <= key < upper][:10]
        else:
            key = parameters["$key"][0]
            lookup = self.snapshot.lookup if table_names("test-v1")[0] in query else self.snapshot.token_lookup
            index = lookup.get(key)
            rows = [] if index is None else [{
                "word": self.snapshot.display_words[index], "row_index": index,
                "vector": np.zeros(300, dtype="<f4").tobytes() if self.corrupt else self.snapshot.vectors[index].tobytes(),
            }]
        return [SimpleNamespace(rows=rows)]

    def close(self):
        self.closed = True


def settings(snapshot):
    return Settings(data_dir=snapshot.vectors.filename.parent, store_backend="ydb",
                    ydb_endpoint="grpcs://example.invalid:2135", ydb_database="/test")


def test_remote_words_keep_exact_search_and_pos_aliases(snapshot):
    connection = FakeConnection(snapshot)
    store = YdbStore(settings(snapshot), connection)
    assert store.suggest("пе") == snapshot.suggest("пе")
    assert store.vector("ПЕЧЬ") == snapshot.vector("ПЕЧЬ")
    assert store.vector("печь_VERB") == snapshot.vector("печь_VERB")
    assert store.vector("нет") is None
    query = [.5, 1, .25] + [0.] * 297
    calls = len(connection.calls)
    assert store.nearest(query, ["печь_VERB"]) == snapshot.nearest(query, ["печь_VERB"])
    assert len(connection.calls) == calls  # nearest never scans YDB


@pytest.mark.parametrize("identity", ["", "another-model"])
def test_runtime_refuses_unpublished_or_mismatched_revisions(snapshot, identity):
    connection = FakeConnection(snapshot)
    connection.identity = identity
    with pytest.raises(StoreUnavailable):
        YdbStore(settings(snapshot), connection)
    assert connection.closed


def test_corrupt_remote_vector_is_rejected(snapshot):
    connection = FakeConnection(snapshot)
    store = YdbStore(settings(snapshot), connection)
    connection.corrupt = True
    with pytest.raises(StoreUnavailable):
        store.vector("печь")


def test_database_errors_do_not_fall_back_or_leak_details(snapshot):
    connection = FakeConnection(snapshot)
    store = YdbStore(settings(snapshot), connection)
    connection.failed = True
    with TestClient(create_app(settings(snapshot), store)) as client:
        response = client.get("/api/words", params={"prefix": "пе"})
        assert response.status_code == 503
        assert "private" not in response.text
        assert response.headers["retry-after"] == "1"
    assert connection.closed


def test_snapshot_hash_mismatch_fails_before_database_access(snapshot):
    path = snapshot.vectors.filename.parent / "words.json"
    path.write_text('["another"]')
    with pytest.raises(ValueError, match="integrity"):
        YdbStore(settings(snapshot), FakeConnection(snapshot))


def test_environment_validates_backend_tls_and_boolean(monkeypatch):
    monkeypatch.setenv("SC_VERIFY_DICTIONARY", "false")
    assert not Settings.from_env().verify_dictionary
    monkeypatch.setenv("SC_STORE_BACKEND", "ydb")
    with pytest.raises(ValueError, match="TLS"):
        Settings.from_env()
