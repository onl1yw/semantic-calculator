from dataclasses import dataclass
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Settings:
    data_dir: Path = ROOT / "data" / "dictionary"
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
            else:
                value = type(default)(raw)
                if value <= 0:
                    raise ValueError(f"SC_{name.upper()} must be positive")
                values[name] = value
        return cls(**values)
