from bisect import bisect_left
from functools import lru_cache
from hashlib import file_digest
import json
from pathlib import Path
import unicodedata

import numpy as np

DIMENSIONS = 300
UPOS_TAGS = {"ADJ", "ADP", "ADV", "AUX", "CCONJ", "DET", "INTJ", "NOUN",
             "NUM", "PART", "PRON", "PROPN", "PUNCT", "SCONJ", "SYM", "VERB", "X"}


def clean_word(word: str) -> str:
    return unicodedata.normalize("NFC", word.strip()).casefold()


class VectorStore:
    """Immutable local dictionary. Only this adapter knows its file layout."""

    def __init__(self, directory: Path, verify=False):
        self.manifest = json.loads((directory / "manifest.json").read_text())
        if verify:
            for name in ("words.json", "vectors.npy"):
                with (directory / name).open("rb") as stream:
                    actual = file_digest(stream, "sha256").hexdigest()
                if self.manifest.get("files_sha256", {}).get(name) != actual:
                    raise ValueError(f"Dictionary integrity check failed: {name}")
        self.words = json.loads((directory / "words.json").read_text())
        self.vectors = np.load(directory / "vectors.npy", mmap_mode="r", allow_pickle=False)
        if (self.vectors.dtype != np.float32
                or self.vectors.shape != (len(self.words), DIMENSIONS)
                or self.manifest["dimensions"] != DIMENSIONS
                or self.manifest["count"] != len(self.words)
                or len(set(self.words)) != len(self.words)):
            raise ValueError("Invalid dictionary: shape, dtype, or vocabulary mismatch")
        self.lookup = {}
        self.aliases = {}
        tagged = self.manifest.get("tagset") == "UPoS"
        self.display_words = [self.lemma(word) if tagged else word for word in self.words]
        self.token_lookup = {clean_word(word): i for i, word in enumerate(self.words)}
        for i, word in enumerate(self.display_words):
            key = clean_word(word)
            if key in self.lookup:
                self.aliases.setdefault(key, [self.lookup[key]]).append(i)
            # Use the first source entry for ambiguous lemmas, while retaining
            # all POS variants for nearest-neighbor search and exclusions.
            if not tagged or key not in self.lookup:
                self.lookup[key] = i
        self.prefix_index = sorted((key, self.display_words[i]) for key, i in self.lookup.items())
        self.prefix_keys = [key for key, _ in self.prefix_index]

    def close(self):
        """The immutable local adapter owns no remote connections."""

    @property
    def metadata(self):
        return {key: self.manifest[key] for key in
                ("model_id", "model_revision", "dimensions", "count")}

    @staticmethod
    def lemma(token):
        word, separator, tag = token.rpartition("_")
        return word if separator and word and tag in UPOS_TAGS else token

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
            index = self.token_lookup.get(clean_word(word))
        if index is None:
            return None
        return {"word": self.display_words[index], "vector": self.vectors[index].tolist(),
                **self.metadata}

    def nearest(self, values, exclude_words=()):
        vector = np.asarray(values, dtype=np.float64)
        # Scaling first prevents overflow even for finite, adversarial numbers.
        scale = np.max(np.abs(vector))
        if scale == 0:
            raise ValueError("Zero vector")
        vector /= scale
        vector /= np.linalg.norm(vector)
        scores = self.vectors @ vector.astype(np.float32)
        excluded = set()
        for word in exclude_words:
            key = clean_word(word)
            if key not in self.lookup and key in self.token_lookup:
                key = clean_word(self.display_words[self.token_lookup[key]])
            if key in self.lookup:
                excluded.update(self.aliases.get(key, [self.lookup[key]]))
        if len(excluded) == len(self.words):
            return None
        if excluded:
            scores[list(excluded)] = -np.inf
        index = int(np.argmax(scores))
        return {"word": self.display_words[index], "similarity": float(np.clip(scores[index], -1, 1)),
                **self.metadata}
