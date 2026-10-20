from datetime import UTC, datetime, timedelta

import pytest

from orbis_engine.db import radar_alerts, radar_items
from orbis_engine.errors import EngineError
from orbis_engine.radar import analyze, service as radar, sources
from orbis_engine.radar.text import canonical_url, hamming, simhash

NOW = "2026-10-18T09:00:00Z"


def e(title, url, summary="", source_type="news", published="2026-10-17T10:00:00Z"):
    return sources._entry(title, url, summary, published, source_type, "src")


def test_canonical_url_and_simhash():
    assert canonical_url("http://www.Example.com/a/?utm_source=x&b=2&a=1#frag") == "https://example.com/a?a=1&b=2"
    a = simhash("Acme launches open-source vector database for search")
    b = simhash("Acme launches open source vector database for search apps")
    c = simhash("Regulators fine bank over data breach")
    assert hamming(a, b) < hamming(a, c)


def test_labels_and_scoring():
    watch = {"query": "vector database", "keywords": ["acme"], "exclude_keywords": ["sponsored"]}
    official = {**e("Acme v2.0 released", "https://github.com/acme/db/releases/v2"), "source_type": "official"}
    assert analyze.label_for(official, 1)[0] == "confirmed"
    assert analyze.label_for(e("Acme may be acquired, sources say", "https://n.com/1"), 1)[0] == "speculative"
    assert analyze.label_for(e("Acme raises Series B", "https://n.com/2"), 1)[0] == "reported"
    assert analyze.label_for(e("Acme raises Series B", "https://m.com/2"), 2)[0] == "confirmed"
    assert analyze.label_for({**e("Show HN: my DB", "https://x.com"), "source_type": "discussion"}, 3)[0] == "speculative"
    s, b = analyze.score_item(e("Acme vector database launch", "https://n.com/3"), watch, {"interests": []}, NOW, novelty="new", publishers=1)
    assert 50 < s <= 100 and b["match"] > 30 and b["novelty"] == 10
    s2, b2 = analyze.score_item(e("Sponsored: Acme vector database", "https://n.com/4"), watch, {}, NOW, novelty="new", publishers=1)
    assert s2 == 0 and b2["excluded_by"] == ["sponsored"]


def test_volume_spike_and_emerging_terms():
    assert analyze.volume_spike([1, 2, 1, 2], 9)["current"] == 9
    assert analyze.volume_spike([1, 2], 9) is None
    recent = [{"id": str(i), "title": f"Agents framework release {i}", "summary": "new agent orchestration", "publisher": f"p{i % 3}"} for i in range(5)]
    prior = [{"id": "x", "title": "Database news", "summary": "", "publisher": "p"}]
    terms = [t["term"] for t in analyze.emerging_terms(recent, prior, {"query": "ai"})]
    assert any("agent" in t for t in terms)


def test_opportunity_needs_interest_and_type():
    item = {"id": "1", "title": "EU opens grant call for climate AI startups, deadline March 3, 2027", "summary": "", "url": "u", "score": 70, "label": "reported"}
    o = analyze.opportunity(item, {"interests": ["climate AI"], "opportunity_types": []})
    assert o and "grant" in o["types"] and o["deadline_text"].lower().startswith("march")
    assert analyze.opportunity(item, {"interests": ["fintech"]}) is None


@pytest.fixture
def fake_fetch(monkeypatch):
    batches = {"n": 0, "data": []}

    def fetch(db, src, query, limit=25):
        return batches["data"][batches["n"]] if batches["n"] < len(batches["data"]) else []

    monkeypatch.setattr(radar, "fetch_source", fetch)
    return batches


def test_baseline_then_changes_and_alert_rules(db, alice, fake_fetch):
    w = radar.create_watch(db, alice, {"name": "Vector DBs", "query": "vector database", "sources": [{"type": "rss", "config": {"url": "https://feeds.test/rss"}}], "alert_mode": "immediate", "sensitivity": "high"})
    fake_fetch["data"] = [
        [e("Acme vector database 1.0", "https://a.com/1"), e("Old vector database news", "https://b.com/2")],
        [e("Acme vector database 1.0", "https://a.com/1?utm_source=x"), {**e("Zeta vector database 2.0 released", "https://github.com/zeta/db/releases/2"), "source_type": "official", "source_name": "zeta/db releases"}, e("Zeta vector database 2.0 released", "https://news.com/zeta"), e("Rumour: Acme vector database may be sold", "https://c.com/r")],
    ]
    first = radar.check_watch(db, alice, w["id"], now=NOW)
    assert first["baseline"] and first["alerts"] == 0 and first["new_items"] == 2
    assert first["watch"]["freshness"]["last_success_at"] == NOW
    fake_fetch["n"] = 1
    second = radar.check_watch(db, alice, w["id"], now="2026-10-18T10:00:00Z")
    assert not second["baseline"]
    assert second["new_items"] == 3  # utm duplicate dropped by URL; the second Zeta report is kept as corroboration (grouped in the feed)
    items = radar.feed(db, alice)
    zeta = next(i for i in items if "Zeta" in i["title"])
    assert len([i for i in items if "Zeta" in i["title"]]) == 1  # one story, grouped
    assert zeta["label"] == "confirmed" and zeta["also_reported_by"]
    rumour = next(i for i in items if "Rumour" in i["title"])
    assert rumour["label"] == "speculative"
    alerts = radar.list_alerts(db, alice)
    immediate = [a for a in alerts if a["delivery"] == "immediate"]
    assert immediate and all("Rumour" not in a["title"] for a in immediate)  # speculation is not pushed by default


def test_daily_alert_cap(db, alice, fake_fetch):
    radar.update_profile(db, alice, {"max_alerts_per_day": 1})
    w = radar.create_watch(db, alice, {"name": "X", "query": "release", "sources": [{"type": "rss", "config": {"url": "https://f.test"}}], "alert_mode": "immediate", "sensitivity": "high"})
    fake_fetch["data"] = [[], [{**e(f"{name} 2.0 release notes", f"https://github.com/o/{name.lower()}/releases/1"), "source_type": "official", "source_name": "releases"} for name in ("Atlas", "Borealis", "Cobalt")]]
    radar.check_watch(db, alice, w["id"], now=NOW)
    fake_fetch["n"] = 1
    radar.check_watch(db, alice, w["id"], now="2026-10-18T11:00:00Z")
    rows = db.select(radar_alerts)
    assert sum(a["delivery"] == "immediate" for a in rows) == 1
    assert any("daily alert limit" in a["reason"] for a in rows)


def test_private_mode_and_validation(db, alice):
    with pytest.raises(EngineError):
        radar.create_watch(db, alice, {"name": "secret", "query": "my acquisition target", "private_mode": True, "sources": [{"type": "web_search"}]})
    w = radar.create_watch(db, alice, {"name": "secret", "private_mode": True, "sources": [{"type": "github_releases", "config": {"repo": "acme/db"}}]})
    assert w["sources"][0]["type"] == "github_releases"
    with pytest.raises(EngineError):
        radar.create_watch(db, alice, {"name": "bad", "query": "x", "frequency": "every-second"})


def test_freshness_states(db, alice):
    w = radar.create_watch(db, alice, {"name": "F", "query": "q", "frequency": "daily"})
    row = db.get(radar.radar_watches, id=w["id"])
    assert radar.freshness(row)["state"] == "never_checked"
    now = datetime(2026, 10, 18, tzinfo=UTC)
    row["last_success_at"] = (now - timedelta(hours=3)).isoformat().replace("+00:00", "Z")
    assert radar.freshness(row, now)["state"] == "fresh"
    row["last_success_at"] = (now - timedelta(days=3)).isoformat().replace("+00:00", "Z")
    assert radar.freshness(row, now)["state"] == "stale"


def test_digest_cites_items_and_reports_freshness(db, alice, fake_fetch):
    w = radar.create_watch(db, alice, {"name": "D", "query": "solar", "sources": [{"type": "rss", "config": {"url": "https://f.test"}}]})
    fake_fetch["data"] = [[], [e("Solar storage breakthrough", "https://a.com/s"), e("Solar storage breakthrough confirmed", "https://b.org/s")]]
    radar.check_watch(db, alice, w["id"], now=NOW)
    fake_fetch["n"] = 1
    radar.check_watch(db, alice, w["id"])
    d = radar.generate_digest(db, alice, "weekly")
    data = d["data"]
    assert data["sources"] and all(s["url"].startswith("https://") for s in data["sources"])
    assert "[1]" in " ".join(data["summary"])
    assert data["freshness"][0]["watch"] == "D"


def test_worker_status_is_honest(db):
    st = radar.worker_status(db)
    assert st["scheduler_running"] is False and "NOT running" in st["statement"]
    from orbis_engine import worker

    worker.run_once(db)
    assert radar.worker_status(db)["scheduler_running"] is True


def test_feed_parser_handles_rss_and_atom():
    rss = '<rss><channel><item><title>A &amp; B</title><link>https://x.com/a</link><pubDate>Fri, 16 Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Hi&lt;/p&gt;</description></item></channel></rss>'
    atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Rel 1</title><link rel="alternate" href="https://github.com/o/r/releases/1"/><updated>2026-10-16T10:00:00Z</updated></entry></feed>'
    r = sources.parse_feed(rss)
    assert r[0]["title"] == "A & B" and r[0]["published_at"] == "2026-10-16T10:00:00Z" and r[0]["summary"] == "Hi"
    assert sources.parse_feed(atom)[0]["url"] == "https://github.com/o/r/releases/1"
    with pytest.raises(EngineError):
        sources.parse_feed("not xml")


def test_delete_watch_removes_items(db, alice, fake_fetch):
    w = radar.create_watch(db, alice, {"name": "Z", "query": "z", "sources": [{"type": "rss", "config": {"url": "https://f.test"}}]})
    fake_fetch["data"] = [[e("z news", "https://z.com/1")]]
    radar.check_watch(db, alice, w["id"], now=NOW)
    assert db.count(radar_items) == 1
    radar.delete_watch(db, alice, w["id"])
    assert db.count(radar_items) == 0


def test_same_headline_from_two_outlets_is_one_story():
    a = {**e("Zephyr vector database adds hybrid keyword and vector search", "https://zephyr.example/x", "Hybrid search combines BM25 with vectors."), "id": "1", "cluster_id": "c1", "simhash": "0"}
    a["simhash"] = format(int(a["content_hash"][:15], 16), "x")
    b = e("Zephyr vector database adds hybrid keyword and vector search", "https://technews.example/y", "The company said hybrid search combines BM25 with vector similarity in one query.")
    cid, members = analyze.cluster(b, [a])
    assert cid == "c1" and members
