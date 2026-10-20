# ORBIS engine (Python)

FastAPI service behind ORBIS AI's AI Lab (Part 7), Signal Radar (Part 8) and
Workspaces / Community / Integrations (Part 9). The Next.js app is the only
client: it authenticates users and calls the engine with a short-lived
HMAC-signed `X-Orbis-Identity` header.

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
export ORBIS_ENGINE_SECRET=...            # same value as the web app's
.venv/bin/python -m orbis_engine          # API on 127.0.0.1:8787 (OpenAPI at /docs)
.venv/bin/python -m orbis_engine.worker   # background worker (or --once from cron)
.venv/bin/python -m pytest               # tests
```

| Package | Contents |
|---|---|
| `api/app.py` | All HTTP endpoints, error envelope, rate limiting, request ids |
| `auth.py` | Signed identity verification |
| `db.py` | SQLAlchemy Core tables (SQLite locally, Postgres in production) |
| `lab/` | Planner (Intent-to-Outcome), validator, safe expressions, executor, templates, tests, versions |
| `radar/` | Source adapters, analysis (dedupe, ranking, labels, patterns, opportunities), service (checks, alerts, digests) |
| `workspace/` | Workspaces, permissions, items, versions, comments, collections, shares, community, import/export |
| `connectors/` | Catalog, OAuth (PKCE), token vault, GitHub and RSS sync, conflicts, consent |
| `security/` | Untrusted content and injection scanning, sensitive-data detection, tool policy, SSRF guard, AES-GCM |
| `worker.py` | Scheduled radar checks, scheduled/radar-triggered workflows, digests, run recovery, retention |

See `../docs/ARCHITECTURE.md` for deployment, security and the roadmap.
