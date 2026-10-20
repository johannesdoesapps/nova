"""Monitoring source adapters. All network fetches use conditional GET (ETag /
Last-Modified) where the source supports it, to save cost and be polite."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote

import httpx

from ..db import Database, http_cache, now_iso
from ..errors import EngineError
from ..lab.tools_impl import html_to_text, web_search
from ..security.netguard import assert_public_url
from .text import canonical_url, content_hash, publisher_of

SOURCE_TYPES: dict[str, dict[str, Any]] = {
    "rss": {"label": "RSS / Atom feed", "needs": "url", "sends_query": False, "cost": "free", "kind": "feed"},
    "github_releases": {"label": "GitHub releases", "needs": "repo", "sends_query": False, "cost": "free", "kind": "official"},
    "arxiv": {"label": "arXiv papers", "needs": "query", "sends_query": True, "cost": "free (rate-limited)", "kind": "preprint"},
    "hacker_news": {"label": "Hacker News", "needs": "query", "sends_query": True, "cost": "free", "kind": "discussion"},
    "web_search": {"label": "Web search", "needs": "query", "sends_query": True, "cost": "paid per query (Tavily/Brave)", "kind": "web"},
}
UA = {"User-Agent": "ORBIS-AI-Radar/0.1 (+https://github.com/; polite fetch)"}
MAX_BYTES = 2_000_000


def _date(s: str | None) -> str | None:
    if not s:
        return None
    s = s.strip()
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        try:
            d = parsedate_to_datetime(s)
        except (TypeError, ValueError):
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=UTC)
    return d.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _get(db: Database, url: str, timeout: float = 20) -> tuple[str | None, bool]:
    """Conditional GET. Returns (body, from_cache). Body is None only on 304 with no cached copy."""
    assert_public_url(url)
    cached = db.get(http_cache, url=url)
    headers = dict(UA)
    if cached:
        if cached["etag"]:
            headers["If-None-Match"] = cached["etag"]
        if cached["last_modified"]:
            headers["If-Modified-Since"] = cached["last_modified"]
    try:
        r = httpx.get(url, headers=headers, timeout=timeout, follow_redirects=False)
        if r.is_redirect and r.headers.get("location"):
            nxt = str(r.next_request.url) if r.next_request else r.headers["location"]
            assert_public_url(nxt)  # re-check every hop
            r = httpx.get(nxt, headers=headers, timeout=timeout, follow_redirects=False)
    except httpx.TimeoutException:
        raise EngineError("timeout", f"Timed out fetching {url}.") from None
    except httpx.HTTPError:
        raise EngineError("upstream_error", f"Could not reach {publisher_of(url)}.") from None
    if r.status_code == 304 and cached:
        db.update(http_cache, {"url": url}, fetched_at=now_iso())
        return cached["body"], True
    if r.status_code == 429:
        raise EngineError("rate_limited", f"{publisher_of(url)} is rate limiting requests.")
    if r.status_code >= 400:
        raise EngineError("upstream_error" if r.status_code >= 500 else "bad_request", f"{publisher_of(url)} returned {r.status_code}.")
    body = r.content[:MAX_BYTES].decode(r.encoding or "utf-8", errors="replace")
    values = {"etag": r.headers.get("etag"), "last_modified": r.headers.get("last-modified"), "body": body, "fetched_at": now_iso()}
    if cached:
        db.update(http_cache, {"url": url}, **values)
    else:
        db.insert(http_cache, url=url, **values)
    return body, False


def _entry(title: str, url: str, summary: str, published: str | None, source_type: str, source_name: str) -> dict[str, Any]:
    title = re.sub(r"\s+", " ", html_to_text(title or "")).strip()[:500] or url
    summary = re.sub(r"\s+", " ", html_to_text(summary or "")).strip()[:2000]
    return {
        "title": title,
        "url": url,
        "canonical_url": canonical_url(url),
        "summary": summary,
        "published_at": _date(published),
        "source_type": source_type,
        "source_name": source_name[:200],
        "publisher": publisher_of(url),
        "content_hash": content_hash(title, summary),
    }


def parse_feed(body: str, source_type: str = "feed", source_name: str = "") -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(body.encode("utf-8", errors="replace"))  # stdlib parser: no external entities resolved
    except ET.ParseError:
        raise EngineError("bad_request", "Not a valid RSS/Atom feed.") from None
    out = []

    def strip(tag: str) -> str:
        return tag.split("}", 1)[-1]

    for el in root.iter():
        t = strip(el.tag)
        if t not in ("item", "entry"):
            continue
        fields: dict[str, str] = {}
        link = None
        for c in el:
            ct = strip(c.tag)
            if ct == "link":
                href = c.attrib.get("href")
                rel = c.attrib.get("rel", "alternate")
                if href and rel == "alternate":
                    link = link or href
                elif c.text and c.text.strip():
                    link = link or c.text.strip()
            elif c.text:
                fields.setdefault(ct, c.text)
        link = link or fields.get("guid") or fields.get("id")
        if not link or not link.startswith(("http://", "https://")):
            continue
        out.append(_entry(fields.get("title", ""), link, fields.get("description") or fields.get("summary") or fields.get("content") or "", fields.get("pubDate") or fields.get("published") or fields.get("updated") or fields.get("date"), source_type, source_name or publisher_of(link)))
    return out


def fetch_feed(db: Database, url: str, limit: int = 50) -> list[dict[str, Any]]:
    if not url.startswith(("https://", "http://")):
        raise EngineError("bad_request", "Feed URL must be http(s).")
    body, _ = _get(db, url)
    return parse_feed(body or "", "feed", publisher_of(url))[:limit]


def fetch_source(db: Database, src: dict[str, Any], watch_query: str, limit: int = 25) -> list[dict[str, Any]]:
    t = src.get("type")
    cfg = src.get("config") or {}
    query = str(cfg.get("query") or watch_query)[:300]
    if t == "rss":
        entries = fetch_feed(db, str(cfg.get("url", "")), limit)
        kind = "official" if src.get("official") else "feed"
        return [{**e, "source_type": kind} for e in entries]
    if t == "github_releases":
        repo = str(cfg.get("repo", ""))
        if not re.fullmatch(r"[\w.-]+/[\w.-]+", repo):
            raise EngineError("bad_request", "GitHub releases source needs owner/repo.")
        body, _ = _get(db, f"https://github.com/{repo}/releases.atom")
        return [{**e, "source_type": "official", "source_name": f"{repo} releases"} for e in parse_feed(body or "", "official", f"{repo} releases")][:limit]
    if t == "arxiv":
        q = " AND ".join(f'all:"{w}"' if " " in w else f"all:{w}" for w in [query])
        body, _ = _get(db, f"https://export.arxiv.org/api/query?search_query={quote(q)}&sortBy=submittedDate&sortOrder=descending&max_results={min(limit, 25)}", timeout=30)
        return [{**e, "source_type": "preprint", "source_name": "arXiv"} for e in parse_feed(body or "", "preprint", "arXiv")]
    if t == "hacker_news":
        try:
            r = httpx.get("https://hn.algolia.com/api/v1/search_by_date", params={"query": query, "tags": "story", "hitsPerPage": min(limit, 30)}, headers=UA, timeout=20)
            r.raise_for_status()
        except httpx.HTTPError:
            raise EngineError("upstream_error", "Hacker News search failed.") from None
        out = []
        for h in r.json().get("hits", []):
            url = h.get("url") or f"https://news.ycombinator.com/item?id={h.get('objectID')}"
            e = _entry(h.get("title") or "", url, f"{h.get('points', 0)} points, {h.get('num_comments', 0)} comments on Hacker News", h.get("created_at"), "discussion", "Hacker News")
            e["discussion_url"] = f"https://news.ycombinator.com/item?id={h.get('objectID')}"
            out.append(e)
        return out
    if t == "web_search":
        res = web_search(query, min(limit, 10))
        if res.get("simulated"):
            raise EngineError("not_configured", res["notice"])
        return [_entry(x["title"], x["url"], x.get("snippet", ""), x.get("published_at"), "web", "Web search") for x in res["results"]]
    raise EngineError("bad_request", f"Unknown source type {t!r}.")
