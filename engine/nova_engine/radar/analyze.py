"""Change detection, deduplication, ranking and labelling. Pure functions over
plain dicts so every number can be explained and tested."""

from __future__ import annotations

import math
import re
from collections import Counter
from datetime import datetime
from typing import Any

from .text import hamming, is_speculative, simhash, tokens

NEAR_DUP_BITS = 6  # SimHash Hamming distance at or below which two items are "the same story"
TITLE_JACCARD = 0.8  # or: titles share at least 80% of their terms
SENSITIVITY_THRESHOLD = {"low": 80, "medium": 65, "high": 50}
DIGEST_MARGIN = 20
SOURCE_PRIOR = {"official": 15, "preprint": 10, "news": 10, "feed": 9, "web": 7, "discussion": 5}
LABEL_HELP = {
    "confirmed": "From an official source, or reported by at least two independent publishers without speculative language.",
    "reported": "Reported by a single source; not yet corroborated.",
    "speculative": "Uses speculative language (rumour, could, plans to, sources say…) or comes from discussion forums.",
}

OPPORTUNITY_TYPES: dict[str, re.Pattern[str]] = {
    "funding": re.compile(r"\b(raises?|raised|funding round|seed round|series [a-e]|investment|venture)\b", re.I),
    "grant": re.compile(r"\b(grants?|call for proposals|funding (call|opportunity)|fellowship|award applications?)\b", re.I),
    "tender": re.compile(r"\b(request for proposals|rfp|tender|procurement|rfq)\b", re.I),
    "launch": re.compile(r"\b(launch(es|ed)?|now available|general availability|ga release|released|introduc(es|ing))\b", re.I),
    "api_or_tool": re.compile(r"\b(api|sdk|open[- ]sourced?|plugin|integration|beta access)\b", re.I),
    "dataset": re.compile(r"\b(dataset|benchmark|corpus|open data)\b", re.I),
    "regulation": re.compile(r"\b(regulation|rule|directive|act|compliance|consultation|deadline|enforcement)\b", re.I),
    "event": re.compile(r"\b(conference|summit|workshop|hackathon|call for papers|cfp|submissions? (due|open))\b", re.I),
    "partnership": re.compile(r"\b(partner(ship|s with)?|collaborat(ion|es)|alliance)\b", re.I),
    "hiring": re.compile(r"\b(hiring|job opening|we're hiring|open roles?)\b", re.I),
}
DEADLINE = re.compile(r"\b(?:deadline|due|closes?|until|by)\s*(?:on\s*)?((?:\d{1,2}\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2})", re.I)


def _age_days(published: str | None, now: str) -> float | None:
    if not published:
        return None
    try:
        a = datetime.fromisoformat(published.replace("Z", "+00:00"))
        b = datetime.fromisoformat(now.replace("Z", "+00:00"))
    except ValueError:
        return None
    return max(0.0, (b - a).total_seconds() / 86400)


def watch_terms(watch: dict[str, Any]) -> list[str]:
    return list(dict.fromkeys(tokens(watch.get("query", "")) + [t for k in watch.get("keywords", []) for t in tokens(k)]))


def score_item(item: dict[str, Any], watch: dict[str, Any], profile: dict[str, Any], now: str, *, novelty: str, publishers: int, source_weight: float = 1.0) -> tuple[float, dict[str, Any]]:
    terms = watch_terms(watch)
    title = set(tokens(item["title"]))
    body = set(tokens(item.get("summary", "")))
    if terms:
        hit = sum(2 if t in title else 1 if t in body else 0 for t in terms)
        match = 40 * min(1.0, hit / (2 * len(terms)) * 1.6)
    else:
        match = 20.0
    interests = [t for i in profile.get("interests", []) for t in tokens(i)]
    interest = 15 * min(1.0, len(set(interests) & (title | body)) / 3) if interests else 0.0
    source = SOURCE_PRIOR.get(item["source_type"], 7) * max(0.0, min(1.5, source_weight))
    age = _age_days(item.get("published_at"), now)
    recency = 5.0 if age is None else 15 * math.pow(0.5, age / 7)
    nov = {"new": 10.0, "corroboration": 4.0, "duplicate": 0.0}[novelty]
    corro = min(5.0, 2.5 * (publishers - 1))
    text = (item["title"] + " " + item.get("summary", "")).lower()
    excluded = [k for k in watch.get("exclude_keywords", []) if k and k.lower() in text]
    muted = [m for m in profile.get("muted_terms", []) if m and m.lower() in text]
    penalty = 30.0 * bool(muted)
    total = 0.0 if excluded else max(0.0, min(100.0, match + interest + source + recency + nov + corro - penalty))
    breakdown = {
        "match": round(match, 1), "interest": round(interest, 1), "source": round(source, 1), "recency": round(recency, 1),
        "novelty": nov, "corroboration": corro, "penalty": -penalty, "excluded_by": excluded, "muted_by": muted,
        "age_days": None if age is None else round(age, 1), "total": round(total, 1),
    }
    return round(total, 1), breakdown


def label_for(item: dict[str, Any], publishers: int) -> tuple[str, str]:
    text = f"{item['title']} {item.get('summary', '')}"
    if item["source_type"] == "discussion":
        return "speculative", "Discussion thread — opinions and claims are unverified."
    if is_speculative(item["title"]) or (item["source_type"] != "official" and is_speculative(text)):
        return "speculative", "Contains speculative language."
    if item["source_type"] == "official":
        return "confirmed", "From an official source (release feed or a source you marked official)."
    if publishers >= 2:
        return "confirmed", f"Reported by {publishers} independent publishers."
    return "reported", "Single source; not yet corroborated."


def cluster(new: dict[str, Any], existing: list[dict[str, Any]]) -> tuple[str | None, list[dict[str, Any]]]:
    """Return (cluster_id, members) of the nearest story, or (None, []) when the item is a new story."""
    h = simhash(new["title"] + " " + new.get("summary", "")[:300])
    nt = set(tokens(new["title"]))
    best = None
    for e in existing:
        if e["content_hash"] == new["content_hash"]:
            best = e
            break
        if hamming(h, int(e["simhash"], 16)) <= NEAR_DUP_BITS:
            best = e
            break
        et = set(tokens(e["title"]))
        # Same headline from another outlet: high title overlap is enough even when summaries differ.
        if len(nt) >= 4 and et and len(nt & et) / len(nt | et) >= TITLE_JACCARD:
            best = e
            break
    if not best:
        return None, []
    return best["cluster_id"], [e for e in existing if e["cluster_id"] == best["cluster_id"]]


def volume_spike(counts_by_check: list[int], current: int) -> dict[str, Any] | None:
    """New-item count well above the baseline rate (mean + 2σ, at least 3 items and 3 prior checks)."""
    if len(counts_by_check) < 3 or current < 3:
        return None
    mean = sum(counts_by_check) / len(counts_by_check)
    sd = math.sqrt(sum((c - mean) ** 2 for c in counts_by_check) / len(counts_by_check))
    if current > mean + 2 * max(sd, 0.5):
        return {"current": current, "baseline_mean": round(mean, 2), "baseline_sd": round(sd, 2)}
    return None


def emerging_terms(recent: list[dict[str, Any]], prior: list[dict[str, Any]], watch: dict[str, Any], top: int = 8) -> list[dict[str, Any]]:
    """Terms (and bigrams) much more frequent recently than in the prior window, seen across ≥2 publishers."""
    skip = set(watch_terms(watch))

    def grams(it: dict[str, Any]) -> set[str]:
        t = [x for x in tokens(it["title"] + " " + it.get("summary", "")[:400]) if x not in skip and not x.isdigit()]
        return set(t) | {f"{a} {b}" for a, b in zip(t, t[1:])}

    rc: Counter[str] = Counter()
    pubs: dict[str, set[str]] = {}
    ev: dict[str, list[str]] = {}
    for it in recent:
        for g in grams(it):
            rc[g] += 1
            pubs.setdefault(g, set()).add(it["publisher"])
            ev.setdefault(g, []).append(it["id"])
    pc: Counter[str] = Counter(g for it in prior for g in grams(it))
    nr, np_ = max(1, len(recent)), max(1, len(prior))
    out = []
    for g, c in rc.items():
        if c < 3 or len(pubs[g]) < 2:
            continue
        lift = (c / nr) / ((pc[g] + 0.5) / np_)  # additive smoothing for terms unseen in the prior window
        if lift >= 2:
            out.append({"term": g, "recent": c, "prior": pc[g], "lift": round(lift, 2), "publishers": len(pubs[g]), "evidence": ev[g][:5]})
    out.sort(key=lambda x: (-x["lift"], -x["recent"]))
    # drop unigrams fully covered by a reported bigram
    seen: set[str] = set()
    final = []
    for x in out:
        if any(x["term"] in s.split() for s in seen):
            continue
        seen.add(x["term"])
        final.append(x)
    return final[:top]


def opportunity(item: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any] | None:
    interests = profile.get("interests") or []
    wanted = set(profile.get("opportunity_types") or OPPORTUNITY_TYPES)
    text = f"{item['title']} {item.get('summary', '')}"
    types = [t for t, p in OPPORTUNITY_TYPES.items() if t in wanted and p.search(text)]
    if not types or not interests:
        return None
    words = set(tokens(text))
    matched = [i for i in interests if set(tokens(i)) & words]
    if not matched:
        return None
    dl = DEADLINE.search(text)
    score = round(min(100.0, item["score"] * 0.6 + 15 * len(matched) + 10 * len(types)), 1)
    return {
        "item_id": item["id"],
        "title": item["title"],
        "url": item["url"],
        "types": types,
        "matched_interests": matched,
        "deadline_text": dl.group(1) if dl else None,
        "label": item["label"],
        "score": score,
        "why": f"Mentions {', '.join(types)} and matches your interests: {', '.join(matched)}.",
    }
