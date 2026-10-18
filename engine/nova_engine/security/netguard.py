"""SSRF guard for user-supplied URLs (feeds, URL-fetch steps, webhooks).

Resolves the host and rejects loopback, private, link-local, multicast,
reserved and cloud-metadata addresses. Set NOVA_ALLOW_PRIVATE_FETCH=1 only for
local development (e.g. a feed served from localhost).
"""

from __future__ import annotations

import ipaddress
import os
import socket
from urllib.parse import urlparse

from ..errors import EngineError


def assert_public_url(url: str) -> None:
    try:
        u = urlparse(url)
    except ValueError:
        raise EngineError("bad_request", "Invalid URL.") from None
    if u.scheme not in ("http", "https") or not u.hostname:
        raise EngineError("bad_request", "Only http(s) URLs are allowed.")
    if os.environ.get("NOVA_ALLOW_PRIVATE_FETCH") == "1":
        return
    host = u.hostname
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        raise EngineError("forbidden", "Internal addresses are not allowed.")
    try:
        infos = socket.getaddrinfo(host, u.port or (443 if u.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise EngineError("bad_request", f"Could not resolve {host}.") from None
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise EngineError("forbidden", "That address points to a private or internal network.")
