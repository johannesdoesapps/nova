"""Model access. Provider keys stay in this process (server-side only).

Model ids follow the web app's registry: "openai:<model>", "huggingface:<repo>",
and "demo:alpha" (a deterministic local simulator, always labelled simulated).
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import time
from dataclasses import dataclass

import httpx

from .config import settings
from .errors import EngineError


@dataclass
class LLMResult:
    text: str
    input_tokens: int
    output_tokens: int
    tokens_estimated: bool
    served_model: str | None
    simulated: bool
    cost_usd: float | None
    latency_ms: int


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / 4)


def price_for(model_id: str) -> tuple[float, float] | None:
    if model_id.startswith("demo:"):
        return (0.0, 0.0)
    return settings().model_prices.get(model_id)


def estimate_cost(model_id: str, input_tokens: int, output_tokens: int) -> float | None:
    p = price_for(model_id)
    if p is None:
        return None
    return round((input_tokens * p[0] + output_tokens * p[1]) / 1_000_000, 8)


def available_models() -> list[dict]:
    s = settings()
    out = []
    if s.openai_key:
        out += [{"id": "openai:gpt-5-mini", "label": "GPT-5 mini"}, {"id": "openai:gpt-5", "label": "GPT-5"}]
    if s.huggingface_key:
        out += [{"id": "huggingface:openai/gpt-oss-120b", "label": "gpt-oss-120b"}]
    out.append({"id": "demo:alpha", "label": "Demo model (simulated)"})
    return [{**m, "simulated": m["id"].startswith("demo:"), "priced": price_for(m["id"]) is not None} for m in out]


def default_model() -> str:
    return available_models()[0]["id"]


def _demo(system: str, user: str, json_mode: bool) -> str:
    """Deterministic simulated output so workflows can be tried without keys."""
    seed = hashlib.sha256((system + user).encode()).hexdigest()[:6]
    if json_mode:
        # Fill the keys the prompt asks for so demo workflows can run end to end; every value says it is simulated.
        keys = re.findall(r'(?:keys?|fields?)\s+((?:"?\w+"?(?:,\s*|\s+and\s+|\s+or\s+)?)+)', user)
        names = [k for group in keys for k in re.findall(r'"?(\w+)"?', group) if k not in ("and", "or", "with", "the")][:8]
        if names:
            return json.dumps({k: f"[Demo mode — simulated {k}]" for k in names} | {"simulated": True})
        return json.dumps({"simulated": True, "summary": "Demo mode — simulated output.", "seed": seed})
    first = re.sub(r"<untrusted[\s\S]*?</untrusted>", "[untrusted content omitted]", user).strip().splitlines()
    head = (first[0] if first else "the request")[:160]
    return (
        "Demo mode — simulated response (no AI provider is configured, so this is template text, not a model output).\n\n"
        f"Task: {head}\n\n"
        "- Point 1: replace this with a real model by setting OPENAI_API_KEY.\n"
        "- Point 2: every step, approval and log in this run is real; only this text is simulated.\n"
        f"(ref {seed})"
    )


def complete(
    model_id: str,
    system: str,
    user: str,
    *,
    max_tokens: int = 1200,
    temperature: float | None = None,
    json_mode: bool = False,
    timeout_s: float = 60,
) -> LLMResult:
    s = settings()
    started = time.monotonic()
    provider, _, name = model_id.partition(":")
    if provider == "demo":
        text = _demo(system, user, json_mode)
        it, ot = estimate_tokens(system + user), estimate_tokens(text)
        return LLMResult(text, it, ot, True, "demo-alpha", True, 0.0, int((time.monotonic() - started) * 1000))
    if provider == "openai":
        key, base = s.openai_key, s.openai_base_url
    elif provider == "huggingface":
        key, base = s.huggingface_key, "https://router.huggingface.co/v1"
    else:
        raise EngineError("bad_request", f"Unknown model provider in {model_id!r}.")
    if not key:
        raise EngineError("not_configured", f"{model_id} is not available: its provider key is not configured.")
    body: dict = {"model": name, "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    body["max_completion_tokens" if provider == "openai" else "max_tokens"] = max_tokens
    if temperature is not None and provider != "openai":
        body["temperature"] = temperature
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    try:
        r = httpx.post(f"{base}/chat/completions", json=body, headers={"Authorization": f"Bearer {key}"}, timeout=timeout_s)
    except httpx.TimeoutException:
        raise EngineError("timeout", f"{model_id} did not respond within {timeout_s:.0f}s.") from None
    except httpx.HTTPError:
        raise EngineError("upstream_error", f"Could not reach {provider}.") from None
    if r.status_code == 429:
        raise EngineError("rate_limited", f"{model_id} is rate limited.")
    if r.status_code in (401, 403):
        raise EngineError("not_configured", f"{provider} rejected the API key.")
    if r.status_code >= 500:
        raise EngineError("upstream_error", f"{provider} returned {r.status_code}.")
    if r.status_code >= 400:
        raise EngineError("bad_request", f"{provider} returned {r.status_code}: {r.text[:200]}")
    j = r.json()
    text = (j.get("choices") or [{}])[0].get("message", {}).get("content") or ""
    usage = j.get("usage") or {}
    it, ot = usage.get("prompt_tokens"), usage.get("completion_tokens")
    est = it is None or ot is None
    it = it if it is not None else estimate_tokens(system + user)
    ot = ot if ot is not None else estimate_tokens(text)
    return LLMResult(text, it, ot, est, j.get("model"), False, estimate_cost(model_id, it, ot), int((time.monotonic() - started) * 1000))


def extract_json(text: str) -> object | None:
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    body = m.group(1) if m else text
    start, end = body.find("{"), body.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(body[start : end + 1])
    except ValueError:
        return None
