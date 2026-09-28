import asyncio
from dataclasses import replace
from hashlib import file_digest, sha256
import json
import socket
from threading import Event

from fastapi import HTTPException
from fastapi.testclient import TestClient
import numpy as np
import pytest

from backend.app import SearchService, create_app
from backend.config import Settings
from backend.limits import ApiGuard, RateLimiter
from backend.store import VectorStore


@pytest.fixture
def dictionary(tmp_path):
    words = ["король", "королева", "мужчина", "женщина"]
    vectors = np.eye(4, 300, dtype=np.float32)
    (tmp_path / "words.json").write_text(json.dumps(words))
    np.save(tmp_path / "vectors.npy", vectors)
    (tmp_path / "manifest.json").write_text(json.dumps({"model_id": "test", "model_revision": "test-v1",
                                                       "dimensions": 300, "count": len(words)}))
    return VectorStore(tmp_path)


@pytest.fixture
def settings(tmp_path):
    return Settings(data_dir=tmp_path, frontend_dir=tmp_path / "no-frontend", ip_burst=100,
                    global_burst=100, ip_search_burst=100, global_search_burst=100)


@pytest.fixture
def client(settings, dictionary):
    with TestClient(create_app(settings, dictionary)) as connection:
        yield connection


def query(vector=None):
    return {"model_revision": "test-v1", "vector": vector if vector is not None else [1.] + [0.] * 299}


def test_lookup_suggestions_and_exact_nearest(client):
    assert client.get("/api/health").json()["count"] == 4
    assert client.get("/api/words", params={"prefix": "КОР"}).json()["words"] == ["королева", "король"]
    word = client.get("/api/words/КОРОЛЬ/vector").json()
    assert len(word["vector"]) == 300
    result = client.post("/api/nearest", json=query(word["vector"]))
    assert result.json()["word"] == "король"
    assert result.json()["similarity"] == pytest.approx(1)
    assert result.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("vector", [[0.] * 300, [1.] * 299, [1.] * 301, [True] * 300,
                                    ["1"] * 300, [None] * 300])
def test_rejects_bad_vectors_without_echoing_them(client, vector):
    result = client.post("/api/nearest", json=query(vector))
    assert result.status_code == 422
    assert "vector" not in result.json()
    assert "input" not in result.text


def test_rejects_nonfinite_json(client):
    for value in ("NaN", "Infinity", "-Infinity"):
        payload = '{"model_revision":"test-v1","vector":[' + ','.join([value] * 300) + ']}'
        assert client.post("/api/nearest", content=payload, headers={"Content-Type": "application/json"}).status_code == 422


def test_revision_unknown_word_and_prefix_constraints(client):
    assert client.post("/api/nearest", json={**query(), "model_revision": "old"}).status_code == 409
    assert client.get("/api/words/несуществующее/vector").status_code == 404
    assert client.get("/api/words", params={"prefix": "к"}).status_code == 422
    assert client.get("/api/words", params={"prefix": "  "}).status_code == 422
    assert client.get("/api/words", params={"prefix": "а" * 65}).status_code == 422
    assert client.post("/api/nearest", json={**query(), "history": ["private"]}).status_code == 422
    assert client.post("/api/calculate", json={}).status_code == 404


def test_body_limit_checks_both_declared_and_chunked_bodies(client):
    assert client.post("/api/nearest", content=b"x" * 16385).status_code == 413
    assert client.post("/api/nearest", content=iter([b"x" * 9000, b"x" * 9000])).status_code == 413
    assert client.post("/api/nearest", content=b"{}", headers={"Content-Length": "20000"}).status_code == 413
    assert client.get("/api/words", params={"prefix": "а" * 2000}).status_code == 414


def test_rate_limiting_is_server_side_and_ignores_forwarded_ip(settings, dictionary):
    limited = replace(settings, ip_burst=2)
    with TestClient(create_app(limited, dictionary)) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/health", headers={"X-Forwarded-For": "1.2.3.4"}).status_code == 200
        blocked = client.get("/api/health", headers={"X-Forwarded-For": "2.3.4.5"})
        assert blocked.status_code == 429
        assert int(blocked.headers["Retry-After"]) > 0


def test_rate_limiter_bounds_client_memory_and_refills(settings):
    now = [0.]
    limiter = RateLimiter(replace(settings, max_clients=2), clock=lambda: now[0])
    assert limiter.allow("one", False) == 0
    assert limiter.allow("two", False) == 0
    assert limiter.allow("three", False) > 0
    assert len(limiter.clients) == 2
    now[0] = 601
    assert limiter.allow("three", False) == 0
    assert len(limiter.clients) == 1


def test_search_timeout_keeps_capacity_until_worker_finishes(settings):
    release = Event()

    class SlowStore:
        def nearest(self, _, exclude_words=()):
            release.wait(1)
            return {"word": "done"}

    async def scenario():
        service = SearchService(SlowStore(), replace(settings, search_timeout=.01, search_concurrency=1))
        try:
            with pytest.raises(HTTPException) as timeout:
                await service.nearest([1.])
            assert timeout.value.status_code == 503
            assert service.active == 1
            with pytest.raises(HTTPException) as busy:
                await service.nearest([1.])
            assert busy.value.status_code == 503
            release.set()
            for _ in range(50):
                if service.active == 0:
                    break
                await asyncio.sleep(.005)
            assert service.active == 0
        finally:
            release.set()
            service.pool.shutdown(wait=True)
    asyncio.run(scenario())


def test_slow_body_times_out_before_application(settings):
    messages = []

    async def forbidden_app(*_):
        raise AssertionError("Application must not receive a slow body")

    async def receive():
        await asyncio.sleep(.1)
        return {"type": "http.request", "body": b"{}"}

    async def send(message):
        messages.append(message)

    guard = ApiGuard(forbidden_app, replace(settings, body_timeout=.01))
    scope = {"type": "http", "path": "/api/nearest", "client": ("one", 1), "headers": [], "query_string": b""}
    asyncio.run(guard(scope, receive, send))
    assert messages[0]["status"] == 408


def test_store_remains_readonly_and_handles_large_finite_values(client, dictionary, settings):
    before = sha256((settings.data_dir / "vectors.npy").read_bytes()).hexdigest()
    result = client.post("/api/nearest", json=query([1e308] + [0.] * 299))
    assert result.status_code == 200
    assert result.json()["word"] == "король"
    assert sha256((settings.data_dir / "vectors.npy").read_bytes()).hexdigest() == before
    assert not dictionary.vectors.flags.writeable


def test_only_frontend_files_are_public(settings, dictionary, tmp_path):
    public = tmp_path / "public"
    public.mkdir()
    (public / "index.html").write_text("<html>Calculator</html>")
    with TestClient(create_app(replace(settings, frontend_dir=public), dictionary)) as client:
        assert client.get("/").status_code == 200
        assert client.get("/data/dictionary-word2vec-nouns/words.json").status_code == 404
        assert client.get("/models/model.model").status_code == 404
        assert client.get("/../words.json").status_code == 404


def test_search_excludes_inputs_without_changing_vectors(client, dictionary):
    vector = [1., .75, .5, .25] + [0.] * 296
    before = dictionary.vectors.copy()
    excluded = client.post("/api/nearest", json={**query(vector),
                           "exclude_words": ["КОРОЛЬ", "несуществующее"]})
    assert excluded.status_code == 200
    assert excluded.json()["word"] == "королева"
    assert excluded.json()["similarity"] == pytest.approx(.75 / np.linalg.norm(vector))
    assert client.post("/api/nearest", json=query(vector)).json()["word"] == "король"
    np.testing.assert_array_equal(before, dictionary.vectors)


def test_excluding_every_candidate_fails_explicitly(client):
    result = client.post("/api/nearest", json={**query(),
                         "exclude_words": ["король", "королева", "мужчина", "женщина"]})
    assert result.status_code == 422
    assert "word" not in result.json()


@pytest.mark.parametrize("excluded", [[1], [""], ["а" * 129], ["а"] * 129, "король"])
def test_exclusion_list_is_bounded_and_validated(client, excluded):
    assert client.post("/api/nearest", json={**query(), "exclude_words": excluded}).status_code == 422


def test_tagged_model_uses_plain_words_and_excludes_every_pos_variant(settings, tmp_path):
    words = ["печь_NOUN", "печь_VERB", "печь_ADJ", "королева_NOUN"]
    vectors = np.eye(len(words), 300, dtype=np.float32)
    (tmp_path / "words.json").write_text(json.dumps(words))
    np.save(tmp_path / "vectors.npy", vectors)
    (tmp_path / "manifest.json").write_text(json.dumps({"model_id": "tagged", "model_revision": "test-v1",
                                                       "dimensions": 300, "count": len(words), "tagset": "UPoS"}))
    store = VectorStore(tmp_path)
    with TestClient(create_app(settings, store)) as connection:
        assert connection.get("/api/words", params={"prefix": "ПЕ"}).json()["words"] == ["печь"]
        first = connection.get("/api/words/ПЕЧЬ/vector").json()
        assert first["word"] == "печь"
        assert first["vector"] == vectors[0].tolist()
        explicit = connection.get("/api/words/печь_VERB/vector").json()
        assert explicit["word"] == "печь"
        assert explicit["vector"] == vectors[1].tolist()
        vector = [.5, 1., .75, .25] + [0.] * 296
        assert connection.post("/api/nearest", json=query(vector)).json()["word"] == "печь"
        for excluded in (["ПЕЧЬ"], ["печь_VERB"]):
            result = connection.post("/api/nearest", json={**query(vector), "exclude_words": excluded})
            assert result.json()["word"] == "королева"
    assert VectorStore.lemma("слово_UNKNOWN") == "слово_UNKNOWN"


def test_application_starts_and_serves_dictionary_without_network(settings, dictionary, monkeypatch):
    def forbidden_connection(*args, **kwargs):
        raise AssertionError("Dictionary operations must not open network connections")

    monkeypatch.setattr(socket.socket, "connect", forbidden_connection)
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/health").status_code == 200
        assert client.get("/api/words", params={"prefix": "кор"}).json()["words"] == ["королева", "король"]
        word = client.get("/api/words/король/vector").json()
        assert client.post("/api/nearest", json=query(word["vector"])).json()["word"] == "король"


@pytest.mark.parametrize("filename", ["words.json", "vectors.npy"])
def test_application_checks_snapshot_hashes_at_startup(settings, dictionary, filename):
    manifest_path = settings.data_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["files_sha256"] = {}
    for name in ("words.json", "vectors.npy"):
        with (settings.data_dir / name).open("rb") as stream:
            manifest["files_sha256"][name] = file_digest(stream, "sha256").hexdigest()
    manifest_path.write_text(json.dumps(manifest))
    verified = replace(settings, verify_dictionary=True)
    with TestClient(create_app(verified)) as client:
        assert client.get("/api/health").status_code == 200
    with (settings.data_dir / filename).open("ab") as stream:
        stream.write(b"corrupt")
    with pytest.raises(ValueError, match="integrity"):
        with TestClient(create_app(verified)):
            pass


def test_environment_validates_dictionary_verification_boolean(monkeypatch):
    monkeypatch.setenv("SC_VERIFY_DICTIONARY", "false")
    assert not Settings.from_env().verify_dictionary
    monkeypatch.setenv("SC_VERIFY_DICTIONARY", "true")
    assert Settings.from_env().verify_dictionary
    monkeypatch.setenv("SC_VERIFY_DICTIONARY", "invalid")
    with pytest.raises(ValueError, match="true or false"):
        Settings.from_env()
