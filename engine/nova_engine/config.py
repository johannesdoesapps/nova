"""Typed settings read from the environment. Secrets never leave the server."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from functools import lru_cache


def _clean(name: str) -> str | None:
    v = os.environ.get(name, "").strip()
    return v or None


def _int(name: str, default: int, lo: int = 0, hi: int = 10**9) -> int:
    try:
        return max(lo, min(hi, int(os.environ.get(name, default))))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    database_url: str
    engine_secret: str | None
    token_keys: dict[str, str]
    active_token_key: str | None
    openai_key: str | None
    openai_base_url: str
    huggingface_key: str | None
    search_provider: str
    search_key: str | None
    model_prices: dict[str, tuple[float, float]] = field(default_factory=dict)
    public_base_url: str = "http://localhost:3000"
    github_client_id: str | None = None
    github_client_secret: str | None = None
    google_client_id: str | None = None
    google_client_secret: str | None = None
    smtp_configured: bool = False
    radar_item_retention_days: int = 90
    max_body_bytes: int = 1_000_000
    dev_insecure_identity: bool = False

    @property
    def real_models(self) -> bool:
        return bool(self.openai_key or self.huggingface_key)


def _model_prices(raw: str | None) -> dict[str, tuple[float, float]]:
    """NOVA_MODEL_PRICES='{"openai:gpt-5-mini":[0.25,2.0]}' — USD per 1M input/output tokens, operator-verified."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        return {k: (float(v[0]), float(v[1])) for k, v in data.items()}
    except (ValueError, TypeError, IndexError, KeyError):
        return {}


def _token_keys(raw: str | None) -> tuple[dict[str, str], str | None]:
    """NOVA_TOKEN_KEYS='k2:<base64 32 bytes>,k1:<base64>' — first key encrypts, all keys decrypt (rotation)."""
    if not raw:
        return {}, None
    keys: dict[str, str] = {}
    active = None
    for part in raw.split(","):
        if ":" not in part:
            continue
        kid, val = part.split(":", 1)
        keys[kid.strip()] = val.strip()
        active = active or kid.strip()
    return keys, active


@lru_cache
def settings() -> Settings:
    keys, active = _token_keys(_clean("NOVA_TOKEN_KEYS"))
    return Settings(
        database_url=_clean("NOVA_ENGINE_DATABASE_URL") or "sqlite:///./nova_engine.db",
        engine_secret=_clean("NOVA_ENGINE_SECRET"),
        token_keys=keys,
        active_token_key=active,
        openai_key=_clean("OPENAI_API_KEY"),
        openai_base_url=(_clean("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/"),
        huggingface_key=_clean("HUGGINGFACE_API_KEY"),
        search_provider=(_clean("SEARCH_PROVIDER") or "tavily").lower(),
        search_key=_clean("SEARCH_API_KEY"),
        model_prices=_model_prices(_clean("NOVA_MODEL_PRICES")),
        public_base_url=(_clean("NEXT_PUBLIC_SITE_URL") or "http://localhost:3000").rstrip("/"),
        github_client_id=_clean("GITHUB_CLIENT_ID"),
        github_client_secret=_clean("GITHUB_CLIENT_SECRET"),
        google_client_id=_clean("GOOGLE_CLIENT_ID"),
        google_client_secret=_clean("GOOGLE_CLIENT_SECRET"),
        smtp_configured=bool(_clean("SMTP_URL")),
        radar_item_retention_days=_int("NOVA_RADAR_RETENTION_DAYS", 90, 1, 3650),
        dev_insecure_identity=os.environ.get("NOVA_ENGINE_DEV_INSECURE") == "1",
    )
