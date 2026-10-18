"""python -m nova_engine  → serve the API with uvicorn (development)."""

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run("nova_engine.api.app:app", host=os.environ.get("NOVA_ENGINE_HOST", "127.0.0.1"), port=int(os.environ.get("NOVA_ENGINE_PORT", "8787")), log_level="info")
