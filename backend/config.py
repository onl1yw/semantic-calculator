from dataclasses import dataclass
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    data_dir: Path = ROOT / "data" / "dictionary-word2vec-nouns"
    frontend_dir: Path = ROOT / "frontend" / "dist"
    max_body_bytes: int = 16 * 1024
    body_timeout: float = 5.0
    search_timeout: float = 2.0
    search_concurrency: int = 2
    ip_per_minute: int = 120
    ip_burst: int = 20
    ip_search_per_minute: int = 60
    ip_search_burst: int = 8
    global_per_minute: int = 1200
    global_burst: int = 40
    global_search_per_minute: int = 240
    global_search_burst: int = 4
    max_clients: int = 2048
    store_backend: str = "local"
    verify_dictionary: bool = False
    ydb_endpoint: str = ""
    ydb_database: str = ""
    ydb_query_timeout: float = 1.0

    def __post_init__(self):
        if self.store_backend not in {"local", "ydb"}:
            raise ValueError("SC_STORE_BACKEND must be local or ydb")
        if self.store_backend == "ydb":
            if not self.ydb_endpoint.startswith("grpcs://") or not self.ydb_database.startswith("/"):
                raise ValueError("YDB requires SC_YDB_ENDPOINT with TLS and SC_YDB_DATABASE")

    @classmethod
    def from_env(cls):
        defaults = cls()
        values = {}
        for name in cls.__dataclass_fields__:
            raw = os.environ.get(f"SC_{name.upper()}")
            if raw is None:
                continue
            default = getattr(defaults, name)
            if isinstance(default, Path):
                values[name] = Path(raw).expanduser().resolve()
            elif isinstance(default, bool):
                if raw.casefold() not in {"true", "false", "1", "0"}:
                    raise ValueError(f"SC_{name.upper()} must be true or false")
                values[name] = raw.casefold() in {"true", "1"}
            elif isinstance(default, str):
                values[name] = raw
            else:
                value = type(default)(raw)
                if value <= 0:
                    raise ValueError(f"SC_{name.upper()} must be positive")
                values[name] = value
        return cls(**values)
