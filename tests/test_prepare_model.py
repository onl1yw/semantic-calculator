import io
import json
import sqlite3
import zipfile

import numpy as np
import pytest

from backend.store import VectorStore
from scripts.prepare_model import DEFAULT_MODEL_ID, DIMENSIONS, MODEL_SPECS, prepare, read_word2vec


def binary_model(words, vectors):
    data = bytearray(f"{len(words)} {DIMENSIONS}\n".encode())
    for word, vector in zip(words, vectors):
        data.extend(word.encode("utf-8") + b" " + vector.astype("<f4").tobytes() + b"\n")
    return bytes(data)


def test_word2vec_import_preserves_source_bytes_and_builds_usable_dictionary(tmp_path, monkeypatch):
    words = ["король_NOUN", "короновать_VERB", "королева_NOUN"]
    vectors = np.arange(1, 3 * DIMENSIONS + 1, dtype=np.float32).reshape(3, DIMENSIONS)
    # A space and newline inside the binary float must not act as delimiters.
    vectors[0, 0] = np.frombuffer(b"\x0a\x20\x80\x3f", dtype="<f4")[0]
    archive = tmp_path / "model.zip"
    with zipfile.ZipFile(archive, "w") as zipped:
        zipped.writestr("meta.json", json.dumps({"id": 182, "dimensions": DIMENSIONS,
                                               "vocabulary size": len(words)}))
        zipped.writestr("model.bin", binary_model(words, vectors))
        zipped.writestr("README", "Source attribution")
    monkeypatch.setitem(MODEL_SPECS, DEFAULT_MODEL_ID,
                        {**MODEL_SPECS[DEFAULT_MODEL_ID], "count": len(words)})
    output = tmp_path / "dictionary"
    manifest = prepare(archive, output, DEFAULT_MODEL_ID)
    assert manifest["model_id"] == DEFAULT_MODEL_ID
    assert manifest["tagset"] == "UPoS"
    assert manifest["pos_filter"] == "NOUN"
    assert manifest["count"] == 2
    assert manifest["source_count"] == 3
    assert json.loads((output / "words.json").read_text()) == [words[0], words[2]]
    np.testing.assert_array_equal(np.load(output / "raw_vectors.npy"), vectors[[0, 2]])
    with sqlite3.connect(output / "dictionary.sqlite3") as db:
        stored = db.execute("SELECT vector FROM words WHERE word = ?", (words[0],)).fetchone()[0]
        assert stored == vectors[0].astype("<f4").tobytes()
    store = VectorStore(output)
    first = store.vector("король")
    assert first["word"] == "король"
    assert store.vector("короновать") is None
    assert store.vector("короновать_VERB") is None
    np.testing.assert_allclose(first["vector"], vectors[0] / np.linalg.norm(vectors[0]), rtol=1e-6)
    assert store.nearest(first["vector"], ["король"])["word"] == "королева"
    assert prepare(archive, output, DEFAULT_MODEL_ID) == manifest
    with (output / "vectors.npy").open("r+b") as file:
        file.seek(-1, 2)
        file.write(b"\x00")
    with pytest.raises(ValueError, match="integrity check"):
        prepare(archive, output, DEFAULT_MODEL_ID)


@pytest.mark.parametrize("problem", ["header", "truncated", "duplicate"])
def test_word2vec_rejects_mismatched_or_incomplete_data(tmp_path, problem):
    words = ["кот_NOUN", "собака_NOUN"]
    vectors = np.ones((2, DIMENSIONS), dtype=np.float32)
    if problem == "duplicate":
        words[1] = words[0]
    data = binary_model(words, vectors)
    if problem == "header":
        data = data.replace(b"2 300\n", b"2 299\n", 1)
    elif problem == "truncated":
        data = data[:-100]
    with pytest.raises(ValueError):
        read_word2vec(io.BytesIO(data), tmp_path / "raw.npy", 2)
