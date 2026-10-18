"""Signal Radar & Opportunity Radar.

Honesty rules baked in:
  * Checks happen only when someone presses "Check now" or the scheduled
    worker runs. The API reports whether the worker is alive and when every
    watch was last checked; nothing claims continuous monitoring.
  * The first successful check of a watch records a baseline. Only items that
    are new relative to that baseline can raise alerts.
  * Items carry a label (confirmed / reported / speculative), source citations
    and a score breakdown. Digests cite the items they summarise.
"""

from __future__ import annotations

import random
import re
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel, Field, ValidationError, field_validator

from ..auth import Identity
from ..db import Database, new_id, now_iso, radar_alerts, radar_checks, radar_digests, radar_items, radar_profiles, radar_watches, worker_heartbeats
from ..errors import EngineError
from ..security.content import scan_injection
from .analyze import DIGEST_MARGIN, LABEL_HELP, SENSITIVITY_THRESHOLD, cluster, emerging_terms, label_for, opportunity, score_item, volume_spike
from .sources import SOURCE_TYPES, fetch_source
from .text import simhash

FREQUENCIES = {"manual": None, "hourly": 3600, "daily": 86400, "weekly": 7 * 86400}
WATCH_KINDS = ("topic", "question", "project", "source", "industry", "technology", "competitor")
MAX_WATCHES = 50


class SourceCfg(BaseModel):
    type: str
    config: dict[str, Any] = {}
    official: bool = False
    weight: float = Field(1.0, ge=0, le=1.5)

    @field_validator("type")
    @classmethod
    def _t(cls, v: str) -> str:
        if v not in SOURCE_TYPES:
            raise ValueError(f"unknown source type {v}")
        return v


class WatchCfg(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: str = "topic"
    query: str = Field("", max_length=300)
    keywords: list[str] = Field([], max_length=20)
    exclude_keywords: list[str] = Field([], max_length=20)
    sources: list[SourceCfg] = Field([], max_length=10)
    frequency: str = "daily"
    sensitivity: str = "medium"
    alert_mode: str = "digest"  # off | digest | immediate
    include_speculative_alerts: bool = False
    private_mode: bool = False  # never send this watch's query to third parties
    max_items_per_check: int = Field(25, ge=1, le=50)
    workspace_id: str | None = None
    notes: str = Field("", max_length=1000)
    muted_until: str | None = None

    @field_validator("kind")
    @classmethod
    def _k(cls, v: str) -> str:
        if v not in WATCH_KINDS:
            raise ValueError("unknown kind")
        return v

    @field_validator("frequency")
    @classmethod
    def _f(cls, v: str) -> str:
        if v not in FREQUENCIES:
            raise ValueError("frequency must be manual, hourly, daily or weekly")
        return v

    @field_validator("sensitivity")
    @classmethod
    def _s(cls, v: str) -> str:
        if v not in SENSITIVITY_THRESHOLD:
            raise ValueError("sensitivity must be low, medium or high")
        return v

    @field_validator("alert_mode")
    @classmethod
    def _a(cls, v: str) -> str:
        if v not in ("off", "digest", "immediate"):
            raise ValueError("alert_mode must be off, digest or immediate")
        return v


DEFAULT_PROFILE = {
    "interests": [],
    "opportunity_types": [],
    "muted_terms": [],
    "quiet_hours": {"start": 22, "end": 7, "timezone_offset_minutes": 0, "enabled": False},
    "max_alerts_per_day": 5,
    "digest": "weekly",  # off | daily | weekly
    "channels": ["in_app"],
    "max_web_searches_per_day": 20,
    "retention_days": 90,
}


def _validate_watch(raw: dict[str, Any]) -> dict[str, Any]:
    try:
        w = WatchCfg.model_validate(raw).model_dump()
    except ValidationError as e:
        raise EngineError("bad_request", "Watch settings are invalid.", [{"path": ".".join(map(str, x["loc"])), "message": x["msg"]} for x in e.errors()[:10]]) from None
    if not w["query"] and not any(s["config"].get("url") or s["config"].get("repo") for s in w["sources"]):
        raise EngineError("bad_request", "Give the watch a query or at least one feed / repository source.")
    if not w["sources"]:
        # Sensible free defaults; web search only when a key exists (and isn't private).
        defaults = []
        if w["kind"] in ("technology", "competitor", "topic", "industry"):
            defaults.append({"type": "hacker_news", "config": {}, "official": False, "weight": 1.0})
        if w["kind"] in ("question", "technology", "topic", "project"):
            defaults.append({"type": "arxiv", "config": {}, "official": False, "weight": 1.0})
        w["sources"] = defaults
    if w["private_mode"]:
        leaking = [s["type"] for s in w["sources"] if SOURCE_TYPES[s["type"]]["sends_query"]]
        if leaking:
            raise EngineError("bad_request", f"Private mode can't use sources that receive your query: {', '.join(leaking)}. Use feeds or GitHub releases.")
    for s in w["sources"]:
        need = SOURCE_TYPES[s["type"]]["needs"]
        if need == "url" and not str(s["config"].get("url", "")).startswith(("https://", "http://")):
            raise EngineError("bad_request", "Feed sources need an http(s) URL.")
        if need == "repo" and not re.fullmatch(r"[\w.-]+/[\w.-]+", str(s["config"].get("repo", ""))):
            raise EngineError("bad_request", "GitHub release sources need owner/repo.")
    return w


def _next_check(freq: str, base: datetime | None = None) -> str | None:
    secs = FREQUENCIES[freq]
    if secs is None:
        return None
    base = base or datetime.now(UTC)
    jitter = random.uniform(0, min(600, secs * 0.05))  # spread load
    return (base + timedelta(seconds=secs + jitter)).isoformat(timespec="seconds").replace("+00:00", "Z")


def _own(db: Database, ident: Identity, wid: str) -> dict[str, Any]:
    w = db.get(radar_watches, id=wid)
    if not w or w["owner_id"] != ident.sub:
        raise EngineError("not_found", "Watch not found.")
    return w


# ─── profile ────────────────────────────────────────────────────────────────
def get_profile(db: Database, ident: Identity) -> dict[str, Any]:
    p = db.get(radar_profiles, owner_id=ident.sub)
    return {**DEFAULT_PROFILE, **(p["data"] if p else {})}


def update_profile(db: Database, ident: Identity, patch: dict[str, Any]) -> dict[str, Any]:
    cur = get_profile(db, ident)
    allowed = set(DEFAULT_PROFILE)
    for k, v in patch.items():
        if k not in allowed:
            continue
        if k in ("interests", "muted_terms", "opportunity_types"):
            v = [str(x).strip()[:80] for x in (v or []) if str(x).strip()][:40]
        if k == "max_alerts_per_day":
            v = max(0, min(50, int(v)))
        if k == "digest" and v not in ("off", "daily", "weekly"):
            raise EngineError("bad_request", "digest must be off, daily or weekly.")
        if k == "channels":
            v = [c for c in v if c in ("in_app", "email")] or ["in_app"]
        if k == "retention_days":
            v = max(7, min(365, int(v)))
        if k == "max_web_searches_per_day":
            v = max(0, min(500, int(v)))
        cur[k] = v
    if db.get(radar_profiles, owner_id=ident.sub):
        db.update(radar_profiles, {"owner_id": ident.sub}, data=cur, updated_at=now_iso())
    else:
        db.insert(radar_profiles, owner_id=ident.sub, data=cur, updated_at=now_iso())
    return cur


# ─── watches ────────────────────────────────────────────────────────────────
def create_watch(db: Database, ident: Identity, raw: dict[str, Any]) -> dict[str, Any]:
    if db.count(radar_watches, {"owner_id": ident.sub}) >= MAX_WATCHES:
        raise EngineError("rate_limited", f"Watch limit reached ({MAX_WATCHES}).")
    data = _validate_watch(raw)
    now = now_iso()
    w = db.insert(radar_watches, id=new_id(), owner_id=ident.sub, data=data, status="active", next_check_at=None, last_checked_at=None, last_success_at=None, baseline_at=None, lease_until=None, last_error=None, created_at=now, updated_at=now)
    db.audit(ident.sub, "watch_create", owner_id=ident.sub, target=w["id"])
    return watch_out(db, w)


def update_watch(db: Database, ident: Identity, wid: str, patch: dict[str, Any]) -> dict[str, Any]:
    w = _own(db, ident, wid)
    status = patch.pop("status", None)
    data = _validate_watch({**w["data"], **patch}) if patch else w["data"]
    values: dict[str, Any] = {"data": data, "updated_at": now_iso()}
    if status in ("active", "paused"):
        values["status"] = status
    if "frequency" in patch:
        values["next_check_at"] = _next_check(data["frequency"]) if w["baseline_at"] else None
    db.update(radar_watches, {"id": wid}, **values)
    return watch_out(db, db.get(radar_watches, id=wid))  # type: ignore[arg-type]


def delete_watch(db: Database, ident: Identity, wid: str) -> None:
    _own(db, ident, wid)
    for t in (radar_items, radar_alerts, radar_checks):
        db.delete(t, watch_id=wid)
    db.delete(radar_watches, id=wid)
    db.audit(ident.sub, "watch_delete", owner_id=ident.sub, target=wid)


def freshness(w: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(UTC)
    freq = w["data"]["frequency"]
    secs = FREQUENCIES[freq]
    last = w["last_success_at"]
    if not last:
        state = "never_checked"
    elif secs is None:
        state = "manual"
    else:
        age = (now - datetime.fromisoformat(last.replace("Z", "+00:00"))).total_seconds()
        state = "fresh" if age <= secs * 1.2 else "due" if age <= secs * 2 else "stale"
    if w["last_error"] and (not last or (w["last_checked_at"] or "") > last):
        state = "error"
    return {"state": state, "last_checked_at": w["last_checked_at"], "last_success_at": last, "next_check_at": w["next_check_at"], "frequency": freq, "last_error": w["last_error"]}


def watch_out(db: Database, w: dict[str, Any]) -> dict[str, Any]:
    return {
        **{k: w[k] for k in ("id", "status", "created_at", "updated_at", "baseline_at")},
        **w["data"],
        "freshness": freshness(w),
        "item_count": db.count(radar_items, {"watch_id": w["id"]}),
        "new_count": db.count(radar_items, {"watch_id": w["id"], "is_baseline": False, "dismissed": False}),
        "cost": {"paid_queries_per_check": sum(1 for s in w["data"]["sources"] if s["type"] == "web_search"), "sources": [{"type": s["type"], **SOURCE_TYPES[s["type"]]} for s in w["data"]["sources"]]},
    }


def list_watches(db: Database, ident: Identity) -> list[dict[str, Any]]:
    return [watch_out(db, w) for w in db.select(radar_watches, {"owner_id": ident.sub}, order_by="created_at", desc=True)]


# ─── checking ───────────────────────────────────────────────────────────────
def _in_quiet_hours(profile: dict[str, Any], now: datetime) -> bool:
    q = profile["quiet_hours"]
    if not q.get("enabled"):
        return False
    local = now + timedelta(minutes=int(q.get("timezone_offset_minutes", 0)))
    h, s, e = local.hour, int(q.get("start", 22)), int(q.get("end", 7))
    return s <= h or h < e if s > e else s <= h < e


def check_watch(db: Database, ident: Identity, wid: str, trigger: str = "manual", now: str | None = None) -> dict[str, Any]:
    w = _own(db, ident, wid)
    now = now or now_iso()
    now_dt = datetime.fromisoformat(now.replace("Z", "+00:00"))
    data = w["data"]
    profile = get_profile(db, ident)
    if trigger == "manual":
        recent = db.count(radar_checks, {"watch_id": wid, "trigger": "manual"}, extra=[radar_checks.c.started_at > (now_dt - timedelta(minutes=10)).isoformat().replace("+00:00", "Z")])
        if recent >= 3:
            raise EngineError("rate_limited", "This watch was checked 3 times in the last 10 minutes. Try again shortly.")
    check_id = new_id()
    db.insert(radar_checks, id=check_id, watch_id=wid, owner_id=ident.sub, started_at=now, finished_at=None, status="running", trigger=trigger, stats={})
    is_baseline = w["baseline_at"] is None
    errors: list[str] = []
    fetched: list[dict[str, Any]] = []
    web_used = 0
    day_start = now_dt.replace(hour=0, minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
    web_today = sum((c["stats"] or {}).get("web_searches", 0) for c in db.select(radar_checks, {"owner_id": ident.sub}, extra=[radar_checks.c.started_at >= day_start]))
    for s in data["sources"]:
        if s["type"] == "web_search":
            if web_today + web_used >= profile["max_web_searches_per_day"]:
                errors.append("web_search skipped: daily web-search budget reached")
                continue
            web_used += 1
        try:
            fetched += [{**e, "source_weight": s.get("weight", 1.0)} for e in fetch_source(db, s, data["query"], data["max_items_per_check"])]
        except EngineError as e:
            errors.append(f"{s['type']}: {e.message}")
    existing = db.select(radar_items, {"watch_id": wid}, order_by="fetched_at", desc=True, limit=2000)
    known_urls = {e["canonical_url"] for e in existing}
    created: list[dict[str, Any]] = []
    upgraded = 0
    seen_now: set[str] = set()
    for e in fetched:
        if e["canonical_url"] in known_urls or e["canonical_url"] in seen_now:
            continue
        seen_now.add(e["canonical_url"])
        cid, members = cluster(e, existing + created)
        publishers = len({m["publisher"] for m in members} | {e["publisher"]})
        novelty = "new" if cid is None else ("corroboration" if e["publisher"] not in {m["publisher"] for m in members} else "duplicate")
        score, breakdown = score_item(e, data, profile, now, novelty=novelty, publishers=publishers, source_weight=e.get("source_weight", 1.0))
        label, why = label_for(e, publishers)
        breakdown["label_reason"] = why
        inj = scan_injection(e["title"] + " " + e.get("summary", ""))
        if inj:
            breakdown["injection_flags"] = inj
        item = {
            "id": new_id(), "owner_id": ident.sub, "watch_id": wid, "canonical_url": e["canonical_url"], "url": e["url"], "title": e["title"], "summary": e.get("summary", ""),
            "source_type": e["source_type"], "source_name": e["source_name"], "publisher": e["publisher"], "published_at": e.get("published_at"), "fetched_at": now,
            "content_hash": e["content_hash"], "simhash": format(simhash(e["title"] + " " + e.get("summary", "")[:300]), "x"), "cluster_id": cid or new_id(),
            "is_baseline": is_baseline, "label": label, "score": score, "breakdown": breakdown,
            "change_kind": None if is_baseline else ("new_development" if novelty == "new" else "corroboration" if novelty == "corroboration" else "duplicate"),
            "dismissed": novelty == "duplicate" or bool(breakdown["excluded_by"]),
        }
        if e["source_type"] == "official" and not is_baseline and novelty == "new":
            item["change_kind"] = "new_release" if "release" in e["source_name"].lower() else "official_update"
        db.insert(radar_items, **item)
        created.append(item)
        if novelty == "corroboration" and not is_baseline:
            # A second independent publisher may upgrade the story to confirmed.
            for m in members:
                if m["label"] == "reported" and publishers >= 2 and label == "confirmed":
                    db.update(radar_items, {"id": m["id"]}, label="confirmed", breakdown={**m["breakdown"], "label_reason": f"Corroborated by {publishers} publishers."})
                    upgraded += 1
    prior_counts = [int((c["stats"] or {}).get("new_items", 0)) for c in db.select(radar_checks, {"watch_id": wid, "status": ["ok", "partial"]}, order_by="started_at", desc=True, limit=20) if not (c["stats"] or {}).get("baseline")]
    fresh = [c for c in created if not c["dismissed"]]
    spike = None if is_baseline else volume_spike(prior_counts, len(fresh))
    alerts = 0 if is_baseline else _alerts(db, ident, w, profile, fresh, spike, now_dt)
    status = "error" if errors and not fetched else "partial" if errors else "ok"
    stats = {"fetched": len(fetched), "new_items": len(fresh), "duplicates": len(created) - len(fresh), "upgraded": upgraded, "alerts": alerts, "errors": errors, "baseline": is_baseline, "web_searches": web_used, "volume_spike": spike}
    db.update(radar_checks, {"id": check_id}, finished_at=now_iso(), status=status, stats=stats)
    values: dict[str, Any] = {"last_checked_at": now, "last_error": "; ".join(errors)[:1000] or None, "lease_until": None, "updated_at": now_iso()}
    if status != "error":
        values["last_success_at"] = now
        if is_baseline:
            values["baseline_at"] = now
    values["next_check_at"] = _next_check(data["frequency"], now_dt)
    db.update(radar_watches, {"id": wid}, **values)
    return {"check_id": check_id, "status": status, **stats, "watch": watch_out(db, db.get(radar_watches, id=wid))}  # type: ignore[arg-type]


def _alerts(db: Database, ident: Identity, w: dict[str, Any], profile: dict[str, Any], items: list[dict[str, Any]], spike: dict[str, Any] | None, now: datetime) -> int:
    data = w["data"]
    if data["alert_mode"] == "off" or w["status"] != "active":
        return 0
    if data.get("muted_until") and data["muted_until"] > now.isoformat():
        return 0
    threshold = SENSITIVITY_THRESHOLD[data["sensitivity"]]
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")
    sent_today = db.count(radar_alerts, {"owner_id": ident.sub, "delivery": "immediate"}, extra=[radar_alerts.c.created_at >= day_start])
    quiet = _in_quiet_hours(profile, now)
    # Email delivery needs an email provider, which this release does not include; in-app is always available.
    channel = "in_app"
    made = 0
    alerted_clusters = {a["item_id"] for a in db.select(radar_alerts, {"watch_id": w["id"]})}
    for it in sorted(items, key=lambda x: -x["score"]):
        if it["change_kind"] not in ("new_development", "new_release", "official_update", "corroboration") or it["breakdown"].get("muted_by"):
            continue
        if it["score"] < threshold - DIGEST_MARGIN or it["cluster_id"] in alerted_clusters:
            continue
        eligible_now = data["alert_mode"] == "immediate" and it["score"] >= threshold and (it["label"] == "confirmed" or data["include_speculative_alerts"])
        if eligible_now and (quiet or sent_today >= profile["max_alerts_per_day"]):
            delivery, reason_extra = "digest", " Held for the digest (quiet hours or daily alert limit)."
        elif eligible_now:
            delivery, reason_extra = "immediate", ""
            sent_today += 1
        else:
            delivery, reason_extra = "digest", ""
        reason = f"{it['label'].capitalize()} · score {it['score']:.0f} (threshold {threshold}) · {it['change_kind'].replace('_', ' ')}.{reason_extra}"
        db.insert(radar_alerts, id=new_id(), owner_id=ident.sub, watch_id=w["id"], item_id=it["id"], kind=it["change_kind"], title=it["title"], reason=reason, score=it["score"], channel=channel, delivery=delivery, created_at=now_iso(), read_at=None)
        alerted_clusters.add(it["cluster_id"])
        made += 1
    if spike and data["alert_mode"] != "off":
        db.insert(radar_alerts, id=new_id(), owner_id=ident.sub, watch_id=w["id"], item_id=None, kind="volume_spike", title=f"Unusual volume for “{data['name']}”", reason=f"{spike['current']} new items vs a baseline of {spike['baseline_mean']} ± {spike['baseline_sd']} per check.", score=70, channel=channel, delivery="digest", created_at=now_iso(), read_at=None)
        made += 1
    return made


# ─── reading ────────────────────────────────────────────────────────────────
def _item_out(it: dict[str, Any], watch_names: dict[str, str]) -> dict[str, Any]:
    return {**{k: it[k] for k in ("id", "watch_id", "url", "title", "summary", "source_type", "source_name", "publisher", "published_at", "fetched_at", "cluster_id", "is_baseline", "label", "score", "breakdown", "change_kind", "dismissed")}, "watch_name": watch_names.get(it["watch_id"], ""), "label_help": LABEL_HELP[it["label"]]}


def feed(db: Database, ident: Identity, *, watch_id: str | None = None, include_baseline: bool = False, label: str | None = None, min_score: float = 0, limit: int = 100) -> list[dict[str, Any]]:
    where: dict[str, Any] = {"owner_id": ident.sub, "dismissed": False}
    if watch_id:
        _own(db, ident, watch_id)
        where["watch_id"] = watch_id
    if not include_baseline:
        where["is_baseline"] = False
    if label:
        where["label"] = label
    names = {w["id"]: w["data"]["name"] for w in db.select(radar_watches, {"owner_id": ident.sub})}
    rows = db.select(radar_items, where, extra=[radar_items.c.score >= min_score], order_by="score", desc=True, limit=min(limit, 500))
    clusters: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        clusters.setdefault(r["cluster_id"], []).append(r)
    out = []
    for members in clusters.values():
        head = max(members, key=lambda m: m["score"])
        o = _item_out(head, names)
        o["also_reported_by"] = [{"publisher": m["publisher"], "url": m["url"]} for m in members if m["id"] != head["id"]]
        out.append(o)
    return sorted(out, key=lambda x: -x["score"])


def dismiss_item(db: Database, ident: Identity, item_id: str) -> None:
    it = db.get(radar_items, id=item_id)
    if not it or it["owner_id"] != ident.sub:
        raise EngineError("not_found", "Item not found.")
    db.update(radar_items, {"id": item_id}, dismissed=True)


def search_items(db: Database, ident: Identity, query: str, k: int = 5) -> list[dict[str, Any]]:
    terms = [t for t in re.findall(r"\w+", query.lower()) if len(t) > 2]
    rows = db.select(radar_items, {"owner_id": ident.sub, "dismissed": False}, order_by="fetched_at", desc=True, limit=2000)
    scored = [(sum((r["title"] + " " + (r["summary"] or "")).lower().count(t) for t in terms), r) for r in rows]
    scored = [x for x in scored if x[0] > 0 or not terms]
    scored.sort(key=lambda x: (-x[0], -x[1]["score"]))
    return [{"title": r["title"], "url": r["url"], "label": r["label"], "publisher": r["publisher"], "published_at": r["published_at"], "summary": (r["summary"] or "")[:400]} for _, r in scored[:k]]


def patterns(db: Database, ident: Identity, days: int = 14) -> list[dict[str, Any]]:
    cutoff = (datetime.now(UTC) - timedelta(days=days)).isoformat().replace("+00:00", "Z")
    out = []
    for w in db.select(radar_watches, {"owner_id": ident.sub}):
        items = db.select(radar_items, {"watch_id": w["id"], "dismissed": False}, limit=3000)
        recent = [i for i in items if not i["is_baseline"] and i["fetched_at"] >= cutoff]
        prior = [i for i in items if i["is_baseline"] or i["fetched_at"] < cutoff]
        for t in emerging_terms(recent, prior, w["data"]):
            out.append({**t, "watch_id": w["id"], "watch_name": w["data"]["name"], "note": "Statistical pattern in recent items — not a verified trend."})
    return sorted(out, key=lambda x: -x["lift"])[:30]


def opportunities(db: Database, ident: Identity, limit: int = 30) -> list[dict[str, Any]]:
    profile = get_profile(db, ident)
    rows = db.select(radar_items, {"owner_id": ident.sub, "dismissed": False, "is_baseline": False}, order_by="score", desc=True, limit=1000)
    names = {w["id"]: w["data"]["name"] for w in db.select(radar_watches, {"owner_id": ident.sub})}
    out = []
    for r in rows:
        o = opportunity(r, profile)
        if o:
            out.append({**o, "watch_name": names.get(r["watch_id"], ""), "publisher": r["publisher"], "published_at": r["published_at"]})
    return sorted(out, key=lambda x: -x["score"])[:limit]


def list_alerts(db: Database, ident: Identity, unread_only: bool = False) -> list[dict[str, Any]]:
    where: dict[str, Any] = {"owner_id": ident.sub}
    if unread_only:
        where["read_at"] = None
    return db.select(radar_alerts, where, order_by="created_at", desc=True, limit=200)


def mark_alert_read(db: Database, ident: Identity, alert_id: str | None = None) -> None:
    where: dict[str, Any] = {"owner_id": ident.sub, "read_at": None}
    if alert_id:
        where["id"] = alert_id
    db.update(radar_alerts, where, read_at=now_iso())


def generate_digest(db: Database, ident: Identity, period: str = "weekly", now: str | None = None) -> dict[str, Any]:
    if period not in ("daily", "weekly"):
        raise EngineError("bad_request", "period must be daily or weekly.")
    end = datetime.fromisoformat((now or now_iso()).replace("Z", "+00:00"))
    start = end - timedelta(days=1 if period == "daily" else 7)
    s_iso = start.isoformat().replace("+00:00", "Z")
    watches = db.select(radar_watches, {"owner_id": ident.sub})
    names = {w["id"]: w["data"]["name"] for w in watches}
    thresholds = {w["id"]: SENSITIVITY_THRESHOLD[w["data"]["sensitivity"]] - DIGEST_MARGIN for w in watches}
    items = [i for i in db.select(radar_items, {"owner_id": ident.sub, "is_baseline": False, "dismissed": False}, extra=[radar_items.c.fetched_at >= s_iso], order_by="score", desc=True, limit=500) if i["score"] >= thresholds.get(i["watch_id"], 45)]
    seen: set[str] = set()
    picked = []
    for i in items:
        if i["cluster_id"] in seen:
            continue
        seen.add(i["cluster_id"])
        picked.append(i)
    cites = {i["id"]: n for n, i in enumerate(picked[:30], 1)}
    sections = {lab: [{"n": cites[i["id"]], **_item_out(i, names)} for i in picked[:30] if i["label"] == lab] for lab in ("confirmed", "reported", "speculative")}
    summary_lines = []
    for lab, heading in (("confirmed", "Confirmed"), ("reported", "Reported (single source)"), ("speculative", "Speculation & discussion")):
        if sections[lab]:
            top = sections[lab][:3]
            summary_lines.append(f"{heading}: " + "; ".join(f"{x['title']} [{x['n']}]" for x in top) + ".")
    data = {
        "period": period,
        "summary": summary_lines or ["No new items above your sensitivity thresholds in this period."],
        "summary_method": "extractive (headlines of the highest-scoring items, with citations)",
        "sections": sections,
        "sources": [{"n": n, "title": i["title"], "url": i["url"], "publisher": i["publisher"], "published_at": i["published_at"]} for i in picked[:30] for n in [cites[i["id"]]]],
        "patterns": patterns(db, ident, days=14 if period == "weekly" else 3)[:5],
        "opportunities": opportunities(db, ident, 5),
        "freshness": [{"watch": w["data"]["name"], **freshness(w, end)} for w in watches],
        "alerts_held": db.count(radar_alerts, {"owner_id": ident.sub, "delivery": "digest"}, extra=[radar_alerts.c.created_at >= s_iso]),
    }
    d = db.insert(radar_digests, id=new_id(), owner_id=ident.sub, period=period, period_start=s_iso, period_end=end.isoformat().replace("+00:00", "Z"), data=data, created_at=now_iso())
    return d


def list_digests(db: Database, ident: Identity) -> list[dict[str, Any]]:
    return db.select(radar_digests, {"owner_id": ident.sub}, order_by="created_at", desc=True, limit=30)


def worker_status(db: Database) -> dict[str, Any]:
    hb = db.get(worker_heartbeats, worker="radar")
    alive = False
    if hb:
        age = (datetime.now(UTC) - datetime.fromisoformat(hb["last_beat_at"].replace("Z", "+00:00"))).total_seconds()
        alive = age < 15 * 60
    return {
        "scheduler_running": alive,
        "last_beat_at": hb["last_beat_at"] if hb else None,
        "statement": "Scheduled checks are running; each watch shows when it was last checked." if alive else "Scheduled checks are NOT running on this server. Watches are only checked when you press “Check now”.",
    }


def purge_old(db: Database, now: datetime | None = None) -> int:
    now = now or datetime.now(UTC)
    removed = 0
    for p in db.select(radar_profiles):
        cutoff = (now - timedelta(days=int(p["data"].get("retention_days", 90)))).isoformat().replace("+00:00", "Z")
        before = db.count(radar_items, {"owner_id": p["owner_id"]})
        with db.engine.begin() as c:
            c.execute(radar_items.delete().where(radar_items.c.owner_id == p["owner_id"]).where(radar_items.c.fetched_at < cutoff).where(radar_items.c.is_baseline.is_(False)))
        removed += before - db.count(radar_items, {"owner_id": p["owner_id"]})
    return removed
