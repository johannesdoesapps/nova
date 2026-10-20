"""Tool implementations. Called only by the executor after policy checks pass."""

from __future__ import annotations

import html
import re
from typing import Any
from urllib.parse import urlparse

import httpx

from ..config import settings
from ..errors import EngineError
from ..security.netguard import assert_public_url

MAX_FETCH_BYTES = 1_000_000


def domain_allowed(url: str, allowed: list[str]) -> bool:
    try:
        u = urlparse(url)
    except ValueError:
        return False
    if u.scheme not in ("https", "http") or not u.hostname:
        return False
    host = u.hostname.lower()
    if host in ("localhost",) or host.endswith(".local") or host.endswith(".internal") or re.fullmatch(r"[\d.]+|\[?[0-9a-f:]+\]?", host):
        return False  # no internal addresses / raw IPs (SSRF guard)
    return any(host == d or (d.startswith("*.") and host.endswith(d[1:])) or host.endswith("." + d) for d in allowed)


def html_to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|noscript|template)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?is)<!--.*?-->", " ", raw)
    raw = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h\d>", "\n", raw)
    raw = re.sub(r"<[^>]+>", " ", raw)
    text = html.unescape(raw)
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n\n", text)).strip()


def http_get(url: str, allowed: list[str], timeout_s: float = 20) -> dict[str, Any]:
    if not domain_allowed(url, allowed):
        raise EngineError("forbidden", f"{url} is not on this workflow's allowed domains.")
    assert_public_url(url)
    with httpx.Client(timeout=timeout_s, follow_redirects=False) as c:
        r = c.get(url, headers={"User-Agent": "ORBIS-AI/0.1 (+workflow fetch)"})
        if r.is_redirect:
            loc = r.headers.get("location", "")
            if not domain_allowed(loc, allowed):
                raise EngineError("forbidden", "Redirect to a non-allowed domain was blocked.")
            assert_public_url(loc)
            r = c.get(loc)
    if r.status_code >= 400:
        raise EngineError("upstream_error" if r.status_code >= 500 else "bad_request", f"GET {url} returned {r.status_code}.")
    body = r.content[:MAX_FETCH_BYTES].decode(r.encoding or "utf-8", errors="replace")
    text = html_to_text(body) if "html" in r.headers.get("content-type", "") else body
    return {"url": url, "status": r.status_code, "text": text[:60_000]}


def http_post(url: str, body: Any, allowed: list[str], timeout_s: float = 20) -> dict[str, Any]:
    if not domain_allowed(url, allowed):
        raise EngineError("forbidden", f"{url} is not on this workflow's allowed domains.")
    assert_public_url(url)
    r = httpx.post(url, json=body, timeout=timeout_s, follow_redirects=False)
    if r.status_code >= 500:
        raise EngineError("upstream_error", f"POST returned {r.status_code}.")
    return {"status": r.status_code, "response": r.text[:2000]}


def web_search(query: str, top_k: int = 5, timeout_s: float = 15) -> dict[str, Any]:
    s = settings()
    if not s.search_key:
        return {
            "simulated": True,
            "notice": "No SEARCH_API_KEY configured — no web results were retrieved (nothing was invented).",
            "results": [],
        }
    try:
        if s.search_provider == "brave":
            r = httpx.get(
                "https://api.search.brave.com/res/v1/web/search",
                params={"q": query, "count": top_k},
                headers={"X-Subscription-Token": s.search_key, "Accept": "application/json"},
                timeout=timeout_s,
            )
            r.raise_for_status()
            items = (r.json().get("web") or {}).get("results") or []
            results = [{"title": i.get("title", ""), "url": i.get("url", ""), "snippet": re.sub(r"<[^>]+>", "", i.get("description", "")), "published_at": i.get("page_age")} for i in items]
        else:
            r = httpx.post("https://api.tavily.com/search", json={"api_key": s.search_key, "query": query, "max_results": top_k}, timeout=timeout_s)
            r.raise_for_status()
            results = [{"title": i.get("title", ""), "url": i.get("url", ""), "snippet": i.get("content", ""), "published_at": i.get("published_date")} for i in r.json().get("results", [])]
    except httpx.TimeoutException:
        raise EngineError("timeout", "Web search timed out.") from None
    except httpx.HTTPStatusError as e:
        raise EngineError("rate_limited" if e.response.status_code == 429 else "upstream_error", f"Web search failed ({e.response.status_code}).") from None
    except httpx.HTTPError:
        raise EngineError("upstream_error", "Web search failed.") from None
    return {"simulated": False, "results": [x for x in results if x["url"].startswith(("http://", "https://"))][:top_k]}
