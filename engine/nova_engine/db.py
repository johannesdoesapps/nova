"""Persistence. SQLAlchemy Core so the same code runs on SQLite (local/dev/tests)
and Postgres (Supabase in production). Every query that touches user data is
scoped by owner or workspace membership in the service layer; in Postgres the
same tables are additionally protected by RLS (see supabase/migrations)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Iterable

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    Float,
    Integer,
    MetaData,
    String,
    Table,
    Text,
    UniqueConstraint,
    and_,
    create_engine,
    delete,
    event,
    func,
    insert,
    select,
    update,
)
from sqlalchemy.engine import Engine

metadata = MetaData()


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_id() -> str:
    return str(uuid.uuid4())


def _ts(name: str, **kw: Any) -> Column:
    return Column(name, String(32), **kw)


# ─── Part 7: AI Lab ─────────────────────────────────────────────────────────
tool_grants = Table(
    "tool_grants", metadata,
    Column("user_id", String(120), primary_key=True),
    Column("tool", String(80), primary_key=True),
    _ts("granted_at", nullable=False),
)
workflows = Table(
    "workflows", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("workspace_id", String(36), index=True),
    Column("name", String(200), nullable=False),
    Column("status", String(20), nullable=False),  # draft | published | archived
    Column("latest_version", Integer, nullable=False, default=0),
    Column("draft", JSON, nullable=False),
    Column("tests", JSON, nullable=False, default=list),
    Column("template_id", String(80)),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)
workflow_versions = Table(
    "workflow_versions", metadata,
    Column("workflow_id", String(36), primary_key=True),
    Column("version", Integer, primary_key=True),
    Column("spec", JSON, nullable=False),
    Column("spec_hash", String(64), nullable=False),
    Column("changelog", String(500)),
    Column("created_by", String(120), nullable=False),
    _ts("created_at", nullable=False),
)
runs = Table(
    "runs", metadata,
    Column("id", String(36), primary_key=True),
    Column("workflow_id", String(36), nullable=False, index=True),
    Column("version", Integer, nullable=False),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("status", String(24), nullable=False),
    Column("mode", String(12), nullable=False),  # live | dry_run | test
    Column("inputs", JSON, nullable=False),
    Column("state", JSON, nullable=False),
    Column("cancel_requested", Boolean, nullable=False, default=False),
    Column("error", Text),
    _ts("heartbeat_at"),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
    _ts("finished_at"),
)
run_events = Table(
    "run_events", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("run_id", String(36), nullable=False, index=True),
    Column("seq", Integer, nullable=False),
    _ts("ts", nullable=False),
    Column("level", String(8), nullable=False),
    Column("step_id", String(64)),
    Column("type", String(40), nullable=False),
    Column("message", Text, nullable=False),
    Column("data", JSON),
)
approvals = Table(
    "approvals", metadata,
    Column("id", String(36), primary_key=True),
    Column("run_id", String(36), nullable=False, index=True),
    Column("step_id", String(64), nullable=False),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("kinds", JSON, nullable=False),
    Column("reasons", JSON, nullable=False),
    Column("payload", JSON, nullable=False),
    Column("payload_hash", String(64), nullable=False),
    Column("status", String(12), nullable=False),  # pending | approved | rejected
    Column("decided_by", String(120)),
    _ts("decided_at"),
    Column("note", String(1000)),
    _ts("created_at", nullable=False),
)
outbox = Table(
    "outbox", metadata,
    Column("id", String(36), primary_key=True),
    Column("run_id", String(36), nullable=False, index=True),
    Column("step_id", String(64), nullable=False),
    Column("owner_id", String(120), nullable=False),
    Column("tool", String(80), nullable=False),
    Column("payload", JSON, nullable=False),
    Column("idempotency_key", String(64), nullable=False, unique=True),
    Column("status", String(16), nullable=False),  # simulated | performed | failed
    Column("result", JSON),
    _ts("created_at", nullable=False),
)

# ─── Part 8: Radar ──────────────────────────────────────────────────────────
radar_watches = Table(
    "radar_watches", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("data", JSON, nullable=False),
    Column("status", String(16), nullable=False),  # active | paused | muted
    _ts("next_check_at"),
    _ts("last_checked_at"),
    _ts("last_success_at"),
    _ts("baseline_at"),
    _ts("lease_until"),
    Column("last_error", Text),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)
radar_items = Table(
    "radar_items", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("watch_id", String(36), nullable=False, index=True),
    Column("canonical_url", String(2048), nullable=False),
    Column("url", String(2048), nullable=False),
    Column("title", String(500), nullable=False),
    Column("summary", Text),
    Column("source_type", String(30), nullable=False),
    Column("source_name", String(200), nullable=False),
    Column("publisher", String(200), nullable=False),
    _ts("published_at"),
    _ts("fetched_at", nullable=False),
    Column("content_hash", String(64), nullable=False),
    Column("simhash", String(20), nullable=False),
    Column("cluster_id", String(36), nullable=False, index=True),
    Column("is_baseline", Boolean, nullable=False, default=False),
    Column("label", String(16), nullable=False),  # confirmed | reported | speculative
    Column("score", Float, nullable=False, default=0),
    Column("breakdown", JSON, nullable=False),
    Column("change_kind", String(30)),
    Column("dismissed", Boolean, nullable=False, default=False),
    UniqueConstraint("watch_id", "canonical_url", name="uq_radar_item_url"),
)
radar_checks = Table(
    "radar_checks", metadata,
    Column("id", String(36), primary_key=True),
    Column("watch_id", String(36), nullable=False, index=True),
    Column("owner_id", String(120), nullable=False),
    _ts("started_at", nullable=False),
    _ts("finished_at"),
    Column("status", String(16), nullable=False),
    Column("trigger", String(12), nullable=False),  # manual | scheduled
    Column("stats", JSON, nullable=False),
)
radar_alerts = Table(
    "radar_alerts", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("watch_id", String(36), nullable=False),
    Column("item_id", String(36)),
    Column("kind", String(24), nullable=False),
    Column("title", String(500), nullable=False),
    Column("reason", Text, nullable=False),
    Column("score", Float, nullable=False),
    Column("channel", String(12), nullable=False),
    Column("delivery", String(16), nullable=False),  # immediate | digest | suppressed
    _ts("created_at", nullable=False),
    _ts("read_at"),
)
radar_digests = Table(
    "radar_digests", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("period", String(8), nullable=False),
    _ts("period_start", nullable=False),
    _ts("period_end", nullable=False),
    Column("data", JSON, nullable=False),
    _ts("created_at", nullable=False),
)
radar_profiles = Table(
    "radar_profiles", metadata,
    Column("owner_id", String(120), primary_key=True),
    Column("data", JSON, nullable=False),
    _ts("updated_at", nullable=False),
)
http_cache = Table(
    "http_cache", metadata,
    Column("url", String(2048), primary_key=True),
    Column("etag", String(500)),
    Column("last_modified", String(100)),
    Column("body", Text),
    _ts("fetched_at", nullable=False),
)

# ─── Part 9: Workspaces, community, connectors ──────────────────────────────
workspaces = Table(
    "workspaces", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("name", String(200), nullable=False),
    Column("description", Text),
    Column("visibility", String(12), nullable=False),  # private | link | public
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
    _ts("deleted_at"),
)
workspace_members = Table(
    "workspace_members", metadata,
    Column("id", String(36), primary_key=True),
    Column("workspace_id", String(36), nullable=False, index=True),
    Column("user_id", String(120), index=True),
    Column("email", String(320), nullable=False),
    Column("name", String(200)),
    Column("role", String(12), nullable=False),
    Column("status", String(10), nullable=False),  # active | invited
    Column("invited_by", String(120)),
    _ts("created_at", nullable=False),
    UniqueConstraint("workspace_id", "email", name="uq_member_email"),
)
workspace_items = Table(
    "workspace_items", metadata,
    Column("id", String(36), primary_key=True),
    Column("workspace_id", String(36), nullable=False, index=True),
    Column("type", String(16), nullable=False),
    Column("title", String(300), nullable=False),
    Column("data", JSON, nullable=False),
    Column("current_version", Integer, nullable=False),
    Column("source", JSON),
    Column("remote_version", String(200)),
    Column("created_by", String(120), nullable=False),
    Column("updated_by", String(120), nullable=False),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
    _ts("deleted_at"),
)
item_versions = Table(
    "item_versions", metadata,
    Column("item_id", String(36), primary_key=True),
    Column("version", Integer, primary_key=True),
    Column("title", String(300), nullable=False),
    Column("data", JSON, nullable=False),
    Column("author", String(120), nullable=False),
    Column("change_note", String(500)),
    _ts("created_at", nullable=False),
)
comments = Table(
    "comments", metadata,
    Column("id", String(36), primary_key=True),
    Column("workspace_id", String(36), nullable=False, index=True),
    Column("item_id", String(36), nullable=False, index=True),
    Column("parent_id", String(36)),
    Column("author", String(120), nullable=False),
    Column("author_name", String(200)),
    Column("body", Text, nullable=False),
    Column("anchor", String(500)),
    Column("resolved", Boolean, nullable=False, default=False),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
    _ts("deleted_at"),
)
collections = Table(
    "collections", metadata,
    Column("id", String(36), primary_key=True),
    Column("workspace_id", String(36), nullable=False, index=True),
    Column("name", String(200), nullable=False),
    Column("description", Text),
    Column("item_ids", JSON, nullable=False),
    Column("created_by", String(120), nullable=False),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
)
shares = Table(
    "shares", metadata,
    Column("id", String(36), primary_key=True),
    Column("workspace_id", String(36), nullable=False, index=True),
    Column("item_id", String(36)),
    Column("token_hash", String(64), nullable=False, unique=True),
    Column("role", String(12), nullable=False),
    Column("created_by", String(120), nullable=False),
    _ts("created_at", nullable=False),
    _ts("expires_at"),
    _ts("revoked_at"),
)
community_posts = Table(
    "community_posts", metadata,
    Column("id", String(36), primary_key=True),
    Column("kind", String(24), nullable=False),
    Column("title", String(200), nullable=False),
    Column("description", Text, nullable=False),
    Column("author_id", String(120), nullable=False, index=True),
    Column("author_name", String(200), nullable=False),
    Column("license", String(40), nullable=False),
    Column("content", JSON, nullable=False),
    Column("status", String(12), nullable=False),  # published | hidden | removed
    Column("forks", Integer, nullable=False, default=0),
    Column("reports", Integer, nullable=False, default=0),
    _ts("created_at", nullable=False),
)
community_reports = Table(
    "community_reports", metadata,
    Column("id", String(36), primary_key=True),
    Column("post_id", String(36), nullable=False, index=True),
    Column("reporter", String(120), nullable=False),
    Column("reason", String(1000), nullable=False),
    _ts("created_at", nullable=False),
    UniqueConstraint("post_id", "reporter", name="uq_report_once"),
)
connections = Table(
    "connections", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("workspace_id", String(36)),
    Column("connector_id", String(40), nullable=False),
    Column("status", String(16), nullable=False),  # active | error | revoked | expired
    Column("scopes", JSON, nullable=False),
    Column("account_label", String(200)),
    Column("token_ciphertext", Text),
    Column("token_key_id", String(20)),
    _ts("token_expires_at"),
    Column("config", JSON, nullable=False),
    Column("sync", JSON, nullable=False),
    _ts("created_at", nullable=False),
    _ts("updated_at", nullable=False),
    _ts("revoked_at"),
)
oauth_states = Table(
    "oauth_states", metadata,
    Column("state_hash", String(64), primary_key=True),
    Column("owner_id", String(120), nullable=False),
    Column("connector_id", String(40), nullable=False),
    Column("workspace_id", String(36)),
    Column("code_verifier", String(200), nullable=False),
    _ts("created_at", nullable=False),
    _ts("expires_at", nullable=False),
)
consent_log = Table(
    "consent_log", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(120), nullable=False, index=True),
    Column("connector_id", String(40), nullable=False),
    Column("connection_id", String(36)),
    Column("action", String(20), nullable=False),
    Column("scopes", JSON, nullable=False),
    Column("purpose", String(500), nullable=False),
    _ts("created_at", nullable=False),
)
sync_conflicts = Table(
    "sync_conflicts", metadata,
    Column("id", String(36), primary_key=True),
    Column("connection_id", String(36), nullable=False, index=True),
    Column("owner_id", String(120), nullable=False),
    Column("item_id", String(36), nullable=False),
    Column("local", JSON, nullable=False),
    Column("remote", JSON, nullable=False),
    Column("status", String(12), nullable=False),
    Column("resolution", String(16)),
    _ts("created_at", nullable=False),
    _ts("resolved_at"),
)
audit_log = Table(
    "audit_log", metadata,
    Column("id", Integer, primary_key=True, autoincrement=True),
    Column("owner_id", String(120), index=True),
    Column("workspace_id", String(36), index=True),
    Column("actor", String(120), nullable=False),
    Column("action", String(60), nullable=False),
    Column("target", String(200)),
    Column("data", JSON),
    _ts("created_at", nullable=False),
)
worker_heartbeats = Table(
    "worker_heartbeats", metadata,
    Column("worker", String(60), primary_key=True),
    _ts("last_beat_at", nullable=False),
    Column("data", JSON),
)


class Database:
    """Tiny helper over SQLAlchemy Core. All values pass through bound parameters."""

    def __init__(self, url: str):
        kwargs: dict[str, Any] = {}
        if url.startswith("sqlite"):
            kwargs["connect_args"] = {"check_same_thread": False}
        self.engine: Engine = create_engine(url, future=True, **kwargs)
        if url.startswith("sqlite"):
            @event.listens_for(self.engine, "connect")
            def _pragma(dbapi_conn, _):  # pragma: no cover - sqlite only
                cur = dbapi_conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA busy_timeout=5000")
                cur.close()

        metadata.create_all(self.engine)

    @staticmethod
    def _where(table: Table, where: dict[str, Any]):
        clauses = []
        for k, v in where.items():
            col = table.c[k]
            if isinstance(v, (list, tuple, set)):
                clauses.append(col.in_(list(v)))
            elif v is None:
                clauses.append(col.is_(None))
            else:
                clauses.append(col == v)
        return and_(*clauses) if clauses else None

    def insert(self, table: Table, **values: Any) -> dict[str, Any]:
        with self.engine.begin() as c:
            c.execute(insert(table).values(**values))
        return values

    def get(self, table: Table, **where: Any) -> dict[str, Any] | None:
        rows = self.select(table, where, limit=1)
        return rows[0] if rows else None

    def select(
        self,
        table: Table,
        where: dict[str, Any] | None = None,
        order_by: str | None = None,
        desc: bool = False,
        limit: int | None = None,
        extra: Iterable[Any] = (),
    ) -> list[dict[str, Any]]:
        q = select(table)
        w = self._where(table, where or {})
        if w is not None:
            q = q.where(w)
        for e in extra:
            q = q.where(e)
        if order_by:
            col = table.c[order_by]
            q = q.order_by(col.desc() if desc else col.asc())
        if limit:
            q = q.limit(limit)
        with self.engine.connect() as c:
            return [dict(r._mapping) for r in c.execute(q)]

    def count(self, table: Table, where: dict[str, Any] | None = None, extra: Iterable[Any] = ()) -> int:
        q = select(func.count()).select_from(table)
        w = self._where(table, where or {})
        if w is not None:
            q = q.where(w)
        for e in extra:
            q = q.where(e)
        with self.engine.connect() as c:
            return int(c.execute(q).scalar_one())

    def update(self, table: Table, where: dict[str, Any], **values: Any) -> int:
        with self.engine.begin() as c:
            return c.execute(update(table).where(self._where(table, where)).values(**values)).rowcount

    def delete(self, table: Table, **where: Any) -> int:
        with self.engine.begin() as c:
            return c.execute(delete(table).where(self._where(table, where))).rowcount

    def claim(self, table: Table, where: dict[str, Any], lease_col: str, lease_until: str, now: str, extra: Iterable[Any] = ()) -> bool:
        """Atomically take a lease on one row (used by the worker so two workers never process the same item)."""
        col = table.c[lease_col]
        q = update(table).where(self._where(table, where)).where((col.is_(None)) | (col < now))
        for e in extra:
            q = q.where(e)
        with self.engine.begin() as c:
            return c.execute(q.values({lease_col: lease_until})).rowcount == 1

    def audit(self, actor: str, action: str, *, owner_id: str | None = None, workspace_id: str | None = None, target: str | None = None, data: Any = None) -> None:
        self.insert(audit_log, owner_id=owner_id, workspace_id=workspace_id, actor=actor, action=action, target=target, data=data, created_at=now_iso())


_db: Database | None = None


def get_db() -> Database:
    global _db
    if _db is None:
        from .config import settings

        _db = Database(settings().database_url)
    return _db


def set_db(db: Database | None) -> None:
    """Tests inject an in-memory or temp database."""
    global _db
    _db = db
