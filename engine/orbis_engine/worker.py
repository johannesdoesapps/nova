"""Background worker.

Runs scheduled Radar checks, scheduled workflows, digest generation,
retention clean-up, and crash recovery for workflow runs.

    python -m orbis_engine.worker            # loop (long-running process, e.g. a Fly.io/Render worker)
    python -m orbis_engine.worker --once     # one pass (cron: GitHub Actions, Vercel Cron → HTTP, systemd timer)

There is no hidden always-on monitor: if this process isn't running, nothing
is checked on a schedule, and the UI says so (see radar.service.worker_status).
"""

from __future__ import annotations

import argparse
import logging
import time
from datetime import UTC, datetime, timedelta

from .auth import Identity
from .db import Database, get_db, now_iso, radar_digests, radar_profiles, radar_watches, runs, worker_heartbeats, workflow_versions, workflows
from .errors import EngineError
from .lab import service as lab
from .lab.executor import TERMINAL_RUN
from .radar import service as radar

log = logging.getLogger("orbis.worker")
STALE_RUN_S = 180
SCHEDULE = {"hourly": timedelta(hours=1), "daily": timedelta(days=1), "weekly": timedelta(days=7)}


def beat(db: Database, data: dict | None = None) -> None:
    if db.get(worker_heartbeats, worker="radar"):
        db.update(worker_heartbeats, {"worker": "radar"}, last_beat_at=now_iso(), data=data)
    else:
        db.insert(worker_heartbeats, worker="radar", last_beat_at=now_iso(), data=data)


def recover_runs(db: Database) -> int:
    """Runs whose executor died (engine restart, crash) become 'interrupted' so users can resume them."""
    cutoff = (datetime.now(UTC) - timedelta(seconds=STALE_RUN_S)).isoformat().replace("+00:00", "Z")
    n = 0
    for r in db.select(runs, {"status": "running"}):
        if (r["heartbeat_at"] or r["updated_at"]) < cutoff:
            db.update(runs, {"id": r["id"]}, status="interrupted", error="The engine stopped while this run was in progress. Resume it to continue from the last completed step.", updated_at=now_iso())
            n += 1
    for r in db.select(runs, {"status": "queued"}):
        if r["updated_at"] < cutoff:
            lab._launch(db, Identity(sub=r["owner_id"]), r["id"], wait=True)
            n += 1
    return n


def due_watches(db: Database, limit: int = 20) -> int:
    now = now_iso()
    lease = (datetime.now(UTC) + timedelta(minutes=10)).isoformat().replace("+00:00", "Z")
    done = 0
    candidates = db.select(radar_watches, {"status": "active"}, extra=[radar_watches.c.next_check_at.is_not(None), radar_watches.c.next_check_at <= now], order_by="next_check_at", limit=limit)
    # Watches that have never been checked get their baseline on the first scheduled pass.
    candidates += [w for w in db.select(radar_watches, {"status": "active", "baseline_at": None}, limit=limit) if w["data"]["frequency"] != "manual"]
    for w in candidates:
        if not db.claim(radar_watches, {"id": w["id"]}, "lease_until", lease, now):
            continue  # another worker has it
        ident = Identity(sub=w["owner_id"])
        try:
            res = radar.check_watch(db, ident, w["id"], trigger="scheduled")
            done += 1
            if res["alerts"]:
                trigger_radar_workflows(db, ident, w["id"])
        except EngineError as e:
            db.update(radar_watches, {"id": w["id"]}, last_error=e.message, lease_until=None, last_checked_at=now_iso(), next_check_at=radar._next_check(w["data"]["frequency"]))
        except Exception:  # noqa: BLE001
            log.exception("watch check failed")
            db.update(radar_watches, {"id": w["id"]}, lease_until=None, next_check_at=radar._next_check(w["data"]["frequency"]))
    return done


def _published_spec(db: Database, w: dict) -> dict | None:
    v = db.get(workflow_versions, workflow_id=w["id"], version=w["latest_version"]) if w["latest_version"] else None
    return v["spec"] if v else None


def scheduled_workflows(db: Database) -> int:
    started = 0
    now = datetime.now(UTC)
    for w in db.select(workflows, {"status": "published"}):
        spec = _published_spec(db, w)
        if not spec or spec.get("trigger", {}).get("type") != "schedule":
            continue
        cfg = spec["trigger"].get("config", {})
        every = SCHEDULE.get(cfg.get("every", ""))
        if not every:
            continue
        hour = cfg.get("at_hour_utc")
        if hour is not None and every >= timedelta(days=1) and now.hour != int(hour):
            continue
        last = db.select(runs, {"workflow_id": w["id"], "mode": "live"}, order_by="created_at", desc=True, limit=1)
        if last and datetime.fromisoformat(last[0]["created_at"].replace("Z", "+00:00")) > now - every + timedelta(minutes=5):
            continue
        try:
            lab.start_run(db, Identity(sub=w["owner_id"]), w["id"], {}, mode="live", wait=True)
            started += 1
        except EngineError as e:
            log.warning("scheduled workflow %s not started: %s", w["id"], e.message)
    return started


def trigger_radar_workflows(db: Database, ident: Identity, watch_id: str) -> int:
    n = 0
    for w in db.select(workflows, {"owner_id": ident.sub, "status": "published"}):
        spec = _published_spec(db, w)
        t = (spec or {}).get("trigger", {})
        if t.get("type") == "radar_signal" and t.get("config", {}).get("watch_id") == watch_id:
            try:
                lab.start_run(db, ident, w["id"], {}, mode="live", wait=True)
                n += 1
            except EngineError as e:
                log.warning("radar-triggered workflow %s not started: %s", w["id"], e.message)
    return n


def digests(db: Database) -> int:
    n = 0
    now = datetime.now(UTC)
    for p in db.select(radar_profiles):
        period = p["data"].get("digest", "weekly")
        if period == "off":
            continue
        span = timedelta(days=1 if period == "daily" else 7)
        last = db.select(radar_digests, {"owner_id": p["owner_id"], "period": period}, order_by="created_at", desc=True, limit=1)
        if last and datetime.fromisoformat(last[0]["created_at"].replace("Z", "+00:00")) > now - span:
            continue
        radar.generate_digest(db, Identity(sub=p["owner_id"]), period)
        n += 1
    return n


def run_once(db: Database | None = None) -> dict:
    db = db or get_db()
    stats = {"recovered_runs": recover_runs(db), "watches_checked": due_watches(db), "scheduled_runs": scheduled_workflows(db), "digests": digests(db), "purged_items": radar.purge_old(db)}
    beat(db, stats)
    return stats


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=int, default=60)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    db = get_db()
    if args.once:
        print(run_once(db))
        return
    while True:
        try:
            log.info("pass %s", run_once(db))
        except Exception:  # noqa: BLE001 - keep the worker alive
            log.exception("worker pass failed")
        time.sleep(max(10, args.interval))


if __name__ == "__main__":
    main()
