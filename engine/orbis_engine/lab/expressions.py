"""Templates and a tiny safe expression language for branch conditions.

Templates: {{inputs.topic}}, {{nodes.search.output}}, {{nodes.extract.output.title}}.
Conditions are parsed with Python's ast and evaluated against a whitelist of
node types: no attribute access, no calls except len/lower/upper/contains/
startswith/str/int/float, no imports, no dunder names. Rendering reports
which nodes were referenced so taint can propagate.
"""

from __future__ import annotations

import ast
import json
import re
from typing import Any, Callable

from ..errors import EngineError

_REF = re.compile(r"\{\{\s*([a-z_][\w]*(?:\.[\w-]+)*)\s*\}\}")
MAX_RENDER = 200_000


def lookup(path: str, ctx: dict[str, Any]) -> Any:
    parts = path.split(".")
    if parts[0] not in ("inputs", "nodes"):
        raise EngineError("bad_request", f"Unknown reference root in {{{{{path}}}}}.")
    cur: Any = ctx
    for p in parts:
        if isinstance(cur, dict) and p in cur:
            cur = cur[p]
        elif isinstance(cur, list) and p.isdigit() and int(p) < len(cur):
            cur = cur[int(p)]
        else:
            return None
    return cur


def referenced_nodes(template: Any) -> set[str]:
    found: set[str] = set()
    for s in _strings(template):
        for m in _REF.finditer(s):
            parts = m.group(1).split(".")
            if parts[0] == "nodes" and len(parts) > 1:
                found.add(parts[1])
    return found


def referenced_inputs(template: Any) -> set[str]:
    found: set[str] = set()
    for s in _strings(template):
        for m in _REF.finditer(s):
            parts = m.group(1).split(".")
            if parts[0] == "inputs" and len(parts) > 1:
                found.add(parts[1])
    return found


def _strings(v: Any):
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from _strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from _strings(x)


def _to_text(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False, indent=None)


def render(template: Any, ctx: dict[str, Any], wrap: Callable[[str, Any], str | None] | None = None) -> Any:
    """Render strings (recursively through dicts/lists). A string that is exactly one reference keeps the value's type.

    `wrap(path, value)` may return replacement text for a reference (used to delimit untrusted content in prompts)."""
    if isinstance(template, dict):
        return {k: render(v, ctx, wrap) for k, v in template.items()}
    if isinstance(template, list):
        return [render(v, ctx, wrap) for v in template]
    if not isinstance(template, str):
        return template

    def sub(path: str) -> Any:
        v = lookup(path, ctx)
        if wrap:
            w = wrap(path, v)
            if w is not None:
                return w
        return v

    whole = _REF.fullmatch(template.strip())
    if whole and not wrap:
        return sub(whole.group(1))
    out = _REF.sub(lambda m: _to_text(sub(m.group(1))), template)
    if len(out) > MAX_RENDER:
        raise EngineError("bad_request", "Rendered text is too large.")
    return out


_ALLOWED_NODES = (
    ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not, ast.Compare, ast.Eq, ast.NotEq,
    ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn, ast.Constant, ast.Name, ast.Load, ast.Call,
    ast.List, ast.Tuple, ast.BinOp, ast.Add, ast.Sub, ast.Mult, ast.Div, ast.USub,
)
_FUNCS = {
    "len": lambda x: len(x) if x is not None else 0,
    "lower": lambda x: str(x or "").lower(),
    "upper": lambda x: str(x or "").upper(),
    "contains": lambda a, b: str(b).lower() in str(a or "").lower() if not isinstance(a, (list, dict)) else b in a,
    "startswith": lambda a, b: str(a or "").startswith(str(b)),
    "str": lambda x: _to_text(x),
    "int": lambda x: int(float(x)),
    "float": lambda x: float(x),
}


def evaluate(expr: str, ctx: dict[str, Any]) -> Any:
    """Evaluate a condition such as  len(search) > 0 and contains(summary, "risk")
    where bare names refer to node outputs (search → nodes.search.output) or inputs (inputs are prefixed input_)."""
    if len(expr) > 500:
        raise EngineError("bad_request", "Condition is too long.")
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        raise EngineError("bad_request", f"Invalid condition: {expr!r}") from None
    for n in ast.walk(tree):
        if not isinstance(n, _ALLOWED_NODES):
            raise EngineError("bad_request", f"Condition uses a disallowed construct ({type(n).__name__}).")
        if isinstance(n, ast.Name) and (n.id.startswith("_") or n.id in ("eval", "exec", "open", "import")):
            raise EngineError("bad_request", "Condition uses a disallowed name.")
        if isinstance(n, ast.Call) and not (isinstance(n.func, ast.Name) and n.func.id in _FUNCS):
            raise EngineError("bad_request", "Only len, lower, upper, contains, startswith, str, int and float can be called.")

    def ev(n: ast.AST) -> Any:
        if isinstance(n, ast.Expression):
            return ev(n.body)
        if isinstance(n, ast.Constant):
            return n.value
        if isinstance(n, ast.Name):
            if n.id in ("true", "True"):
                return True
            if n.id in ("false", "False"):
                return False
            if n.id.startswith("input_"):
                return ctx.get("inputs", {}).get(n.id[6:])
            node = ctx.get("nodes", {}).get(n.id)
            return node.get("output") if isinstance(node, dict) else None
        if isinstance(n, (ast.List, ast.Tuple)):
            return [ev(e) for e in n.elts]
        if isinstance(n, ast.UnaryOp):
            v = ev(n.operand)
            return (not v) if isinstance(n.op, ast.Not) else -v
        if isinstance(n, ast.BoolOp):
            vals = [ev(v) for v in n.values]
            return all(vals) if isinstance(n.op, ast.And) else any(vals)
        if isinstance(n, ast.BinOp):
            a, b = ev(n.left), ev(n.right)
            ops = {ast.Add: lambda: a + b, ast.Sub: lambda: a - b, ast.Mult: lambda: a * b, ast.Div: lambda: a / b}
            return ops[type(n.op)]()
        if isinstance(n, ast.Call):
            return _FUNCS[n.func.id](*[ev(a) for a in n.args])  # type: ignore[union-attr]
        if isinstance(n, ast.Compare):
            left = ev(n.left)
            for op, comp in zip(n.ops, n.comparators):
                right = ev(comp)
                ok = {
                    ast.Eq: lambda: left == right, ast.NotEq: lambda: left != right, ast.Lt: lambda: left < right,
                    ast.LtE: lambda: left <= right, ast.Gt: lambda: left > right, ast.GtE: lambda: left >= right,
                    ast.In: lambda: left in right, ast.NotIn: lambda: left not in right,
                }[type(op)]()
                if not ok:
                    return False
                left = right
            return True
        raise EngineError("bad_request", "Unsupported expression.")

    try:
        return ev(tree)
    except EngineError:
        raise
    except Exception as e:  # noqa: BLE001 - surface type errors etc. as condition errors
        raise EngineError("bad_request", f"Condition failed: {e}") from None


def names_in(expr: str) -> set[str]:
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError:
        return set()
    return {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and not n.id.startswith("input_") and n.id not in _FUNCS and n.id not in ("true", "false", "True", "False")}
