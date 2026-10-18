"""Caller identity.

The engine never sees passwords or Supabase sessions. The Next.js tier
authenticates the user, then calls the engine with

    X-Nova-Identity: <base64url(json)>.<hex hmac-sha256(json, NOVA_ENGINE_SECRET)>

where json = {"sub": "<user id or guest:<uuid>>", "email": ..., "name": ..., "exp": <unix seconds>}.
Tokens live for at most 5 minutes. Without NOVA_ENGINE_SECRET the engine
refuses every request unless NOVA_ENGINE_DEV_INSECURE=1 (local development only).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

from .config import settings
from .errors import EngineError

MAX_TTL_S = 300


@dataclass(frozen=True)
class Identity:
    sub: str
    email: str | None = None
    name: str | None = None

    @property
    def is_guest(self) -> bool:
        return self.sub.startswith("guest:")

    @property
    def display(self) -> str:
        return self.name or self.email or ("Guest" if self.is_guest else self.sub[:8])


def sign_identity(sub: str, secret: str, email: str | None = None, name: str | None = None, ttl_s: int = 120) -> str:
    payload = json.dumps({"sub": sub, "email": email, "name": name, "exp": int(time.time()) + ttl_s}, separators=(",", ":")).encode()
    mac = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=") + "." + mac


def verify_identity(header: str | None) -> Identity:
    s = settings()
    if not s.engine_secret:
        if s.dev_insecure_identity and header:
            # Development only: accept "dev:<sub>" without a signature.
            if header.startswith("dev:"):
                return Identity(sub=header[4:][:120] or "dev-user")
        raise EngineError("not_configured", "NOVA_ENGINE_SECRET is not set; the engine refuses unauthenticated calls.")
    if not header or "." not in header:
        raise EngineError("unauthorized", "Missing identity.")
    b64, mac = header.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4))
    except (ValueError, TypeError):
        raise EngineError("unauthorized", "Malformed identity.") from None
    expected = hmac.new(s.engine_secret.encode(), payload, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, mac):
        raise EngineError("unauthorized", "Invalid identity signature.")
    try:
        data = json.loads(payload)
    except ValueError:
        raise EngineError("unauthorized", "Malformed identity.") from None
    exp = int(data.get("exp", 0))
    now = int(time.time())
    if exp < now or exp > now + MAX_TTL_S + 5:
        raise EngineError("unauthorized", "Identity expired.")
    sub = str(data.get("sub", ""))
    if not sub or len(sub) > 120:
        raise EngineError("unauthorized", "Invalid subject.")
    return Identity(sub=sub, email=(data.get("email") or None), name=(data.get("name") or None))
