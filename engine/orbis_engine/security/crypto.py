"""Encryption at rest for OAuth tokens (AES-256-GCM with key ids for rotation).

Keys come from ORBIS_TOKEN_KEYS ("kid:base64key,..."); the first key encrypts
and every listed key can decrypt, so keys can be rotated by prepending a new
one and re-encrypting in the background. Tokens are never returned to the
browser. Without configured keys, a per-process key is used and connections
must be re-authorised after a restart (development only).
"""

from __future__ import annotations

import base64
import json
import os
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import settings
from ..errors import EngineError

_dev_key = AESGCM.generate_key(bit_length=256)


def _keys() -> tuple[dict[str, bytes], str]:
    s = settings()
    if s.token_keys and s.active_token_key:
        try:
            return {k: base64.b64decode(v) for k, v in s.token_keys.items()}, s.active_token_key
        except ValueError:
            raise EngineError("not_configured", "ORBIS_TOKEN_KEYS is not valid base64.") from None
    return {"dev": _dev_key}, "dev"


def encrypt_json(data: dict, aad: str) -> tuple[str, str]:
    keys, kid = _keys()
    nonce = os.urandom(12)
    ct = AESGCM(keys[kid]).encrypt(nonce, json.dumps(data).encode(), aad.encode())
    return base64.b64encode(nonce + ct).decode(), kid


def decrypt_json(ciphertext: str, kid: str, aad: str) -> dict:
    keys, _ = _keys()
    if kid not in keys:
        raise EngineError("not_configured", "The key that encrypted this token is no longer configured; reconnect the integration.")
    raw = base64.b64decode(ciphertext)
    try:
        return json.loads(AESGCM(keys[kid]).decrypt(raw[:12], raw[12:], aad.encode()))
    except Exception:  # noqa: BLE001 - any failure means the token is unusable
        raise EngineError("forbidden", "Stored credentials could not be decrypted; reconnect the integration.") from None


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)
