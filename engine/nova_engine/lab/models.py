"""Workflow definitions (the Intelligence Composer's document format)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

NodeType = Literal["input", "model_call", "retrieval", "transform", "branch", "approval", "action", "output"]
TriggerType = Literal["manual", "schedule", "webhook", "radar_signal"]

NODE_TYPES: dict[str, str] = {
    "input": "Expose workflow inputs to later steps.",
    "model_call": "Call a model with a prompt. Untrusted content is delimited; models cannot call tools.",
    "retrieval": "Fetch evidence: web search, workspace search, radar items or an allow-listed URL. Output is untrusted.",
    "transform": "Deterministic data shaping: template, extract JSON, regex, pick, join, truncate, count.",
    "branch": "Evaluate a safe condition; downstream steps can run only when it is true or false.",
    "approval": "Pause until a person approves. Consequential actions add their own gate automatically.",
    "action": "Use a tool (save, notify, post…). Permissions and approval policy are enforced at run time.",
    "output": "Declare a final result of the workflow.",
}


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RetryPolicy(Strict):
    max_attempts: int = Field(1, ge=1, le=5)
    backoff_s: float = Field(1.0, ge=0, le=60)
    retry_on: list[Literal["timeout", "rate_limited", "upstream_error"]] = ["timeout", "rate_limited", "upstream_error"]


class Condition(Strict):
    node: str
    equals: bool = True


class Node(Strict):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    type: NodeType
    name: str = Field(min_length=1, max_length=120)
    config: dict[str, Any] = {}
    depends_on: list[str] = []
    when: Condition | None = None
    retry: RetryPolicy = RetryPolicy()
    timeout_s: int = Field(60, ge=1, le=600)
    position: dict[str, float] | None = None


class InputDef(Strict):
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{0,39}$")
    label: str | None = None
    type: Literal["string", "text", "number", "boolean", "json"] = "string"
    required: bool = True
    sensitive: bool = False
    default: Any = None


class Trigger(Strict):
    type: TriggerType = "manual"
    config: dict[str, Any] = {}


class Budget(Strict):
    max_cost_usd: float = Field(0.50, ge=0, le=100)
    max_model_calls: int = Field(20, ge=0, le=500)
    max_tokens: int = Field(60_000, ge=0, le=5_000_000)
    max_steps: int = Field(60, ge=1, le=500)
    max_duration_s: int = Field(600, ge=5, le=6 * 3600)
    unknown_price_policy: Literal["allow_with_call_limit", "block"] = "allow_with_call_limit"


class Permissions(Strict):
    tools: list[str] = []
    network_domains: list[str] = []
    allow_external_models: bool = True
    share_sensitive_with_models: bool = False

    @field_validator("network_domains")
    @classmethod
    def _domains(cls, v: list[str]) -> list[str]:
        out = []
        for d in v:
            d = d.strip().lower().removeprefix("https://").removeprefix("http://").split("/")[0]
            if not d or "*" in d[1:] or " " in d:
                raise ValueError(f"Invalid domain {d!r}")
            out.append(d)
        return out


class WorkflowSpec(Strict):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field("", max_length=2000)
    trigger: Trigger = Trigger()
    inputs: list[InputDef] = []
    nodes: list[Node] = Field(min_length=1, max_length=200)
    budget: Budget = Budget()
    permissions: Permissions = Permissions()
    outputs: list[str] = []


class WorkflowTestCase(Strict):
    name: str = Field(min_length=1, max_length=120)
    inputs: dict[str, Any] = {}
    mocks: dict[str, Any] = {}  # node id -> output to use instead of running it
    expect: list[dict[str, Any]] = []  # {node, op: equals|contains|matches|exists|status, value}
