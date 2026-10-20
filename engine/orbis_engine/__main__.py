"""python -m orbis_engine  → serve the API with uvicorn (development)."""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run("orbis_engine.api.app:app", host=os.environ.get("ORBIS_ENGINE_HOST", "127.0.0.1"), port=int(os.environ.get("ORBIS_ENGINE_PORT", "8787")), log_level="info")
