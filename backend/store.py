from bisect import bisect_left
from functools import lru_cache
import json
from pathlib import Path
import unicodedata

import numpy as np

DIMENSIONS = 300


def clean_word(word: str) -> str:
    return unicodedata.normalize("NFC", word.strip()).casefold()


class VectorStore:
    """Immutable local dictionary. Only this adapter knows its file layout."""

    def __init__(self, directory: Path):
        self.manifest = json.loads((directory / "manifest.json").read_text())
        self.words = json.loads((directory / "words.json").read_text())
        self.vectors = np.load(directory / "vectors.npy", mmap_mode="r", allow_pickle=False)
        if (self.vectors.dtype != np.float32
                or self.vectors.shape != (len(self.words), DIMENSIONS)
                or self.manifest["dimensions"] != DIMENSIONS
                or self.manifest["count"] != len(self.words)
                or len(set(self.words)) != len(self.words)):
            raise ValueError("Invalid dictionary: shape, dtype, or vocabulary mismatch")
        self.lookup = {clean_word(word): i for i, word in enumerate(self.words)}
        self.prefix_index = sorted((clean_word(word), word) for word in self.words)
        self.prefix_keys = [key for key, _ in self.prefix_index]

    @property
    def metadata(self):
        return {key: self.manifest[key] for key in
                ("model_id", "model_revision", "dimensions", "count")}

    def suggest(self, prefix: str):
        start = bisect_left(self.prefix_keys, clean_word(prefix))
        result = []
        for key, word in self.prefix_index[start:start + 10]:
            if not key.startswith(clean_word(prefix)):
                break
            result.append(word)
        return result

    @lru_cache(maxsize=256)
    def vector(self, word: str):
        index = self.lookup.get(clean_word(word))
        if index is None:
            return None
        return {"word": self.words[index], "vector": self.vectors[index].tolist(),
                **self.metadata}

    def nearest(self, values):
        vector = np.asarray(values, dtype=np.float64)
        # Scaling first prevents overflow even for finite, adversarial numbers.
        scale = np.max(np.abs(vector))
        if scale == 0:
            raise ValueError("Zero vector")
        vector /= scale
        vector /= np.linalg.norm(vector)
        scores = self.vectors @ vector.astype(np.float32)
        index = int(np.argmax(scores))
        return {"word": self.words[index], "similarity": float(np.clip(scores[index], -1, 1)),
                **self.metadata}
