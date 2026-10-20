"""Text utilities for Radar: canonical URLs, tokens, SimHash near-duplicate detection."""

from __future__ import annotations

import hashlib
import re
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

STOP = set(
    "a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its may might more most "
    "new no not of on or our she should so some such than that the their them then there these they this those to too very was we were what "
    "when where which while who will with would you your also about after again all any because before between both during each few further "
    "here just like only other over own same through under until up upon says said via one two three year years week weeks today now get gets".split()
)
TRACKING = re.compile(r"^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si|spm)$", re.I)

SPECULATIVE = re.compile(
    r"\b(rumou?rs?|reportedly|could|may|might|expected to|is set to|plans? to|planning to|sources (say|said)|according to sources|leak(ed|s)?|"
    r"unconfirmed|speculat\w*|predicts?|forecasts?|likely|considering|in talks|weighs?|eyes|hints?)\b|\?\s*$",
    re.I,
)


def canonical_url(url: str) -> str:
    try:
        u = urlparse(url.strip())
    except ValueError:
        return url.strip()
    host = (u.hostname or "").lower().removeprefix("www.")
    if u.port and u.port not in (80, 443):
        host = f"{host}:{u.port}"
    q = sorted((k, v) for k, v in parse_qsl(u.query, keep_blank_values=False) if not TRACKING.match(k))
    path = re.sub(r"/+$", "", u.path) or "/"
    return urlunparse(("https" if u.scheme in ("http", "https") else u.scheme, host, path, "", urlencode(q), ""))


def publisher_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "unknown").lower().removeprefix("www.")
    except ValueError:
        return "unknown"


def tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"[a-z0-9][a-z0-9+#.-]*[a-z0-9+#]|[a-z0-9]", text.lower()) if t not in STOP and len(t) > 1]


def content_hash(title: str, summary: str) -> str:
    norm = re.sub(r"\s+", " ", f"{title} {summary}".lower()).strip()
    return hashlib.sha256(norm.encode()).hexdigest()


def simhash(text: str, bits: int = 64) -> int:
    toks = tokens(text)
    feats = [" ".join(toks[i : i + 2]) for i in range(max(1, len(toks) - 1))] or toks or [text]
    v = [0] * bits
    for f in feats:
        h = int.from_bytes(hashlib.blake2b(f.encode(), digest_size=8).digest(), "big")
        for i in range(bits):
            v[i] += 1 if h >> i & 1 else -1
    return sum(1 << i for i in range(bits) if v[i] > 0)


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def is_speculative(text: str) -> bool:
    return bool(SPECULATIVE.search(text))
