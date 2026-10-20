import os

import pytest

os.environ["ORBIS_ENGINE_SECRET"] = "test-secret-please-change"
for k in ("OPENAI_API_KEY", "HUGGINGFACE_API_KEY", "SEARCH_API_KEY", "ORBIS_MODEL_PRICES", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "ORBIS_TOKEN_KEYS"):
    os.environ.pop(k, None)

from orbis_engine.auth import Identity, sign_identity  # noqa: E402
from orbis_engine.config import settings  # noqa: E402
from orbis_engine.db import Database, set_db  # noqa: E402
from orbis_engine.lab import service as lab  # noqa: E402

settings.cache_clear()


@pytest.fixture
def db(tmp_path):
    d = Database(f"sqlite:///{tmp_path / 'test.db'}")
    set_db(d)
    lab.run_synchronously(True)
    yield d
    set_db(None)


@pytest.fixture
def alice():
    return Identity(sub="user-alice", email="alice@example.com", name="Alice")


@pytest.fixture
def bob():
    return Identity(sub="user-bob", email="bob@example.com", name="Bob")


@pytest.fixture
def client(db):
    from fastapi.testclient import TestClient

    from orbis_engine.api.app import create_app

    return TestClient(create_app())


def headers(sub="user-alice", email="alice@example.com"):
    return {"X-Orbis-Identity": sign_identity(sub, "test-secret-please-change", email=email)}
