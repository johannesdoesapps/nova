"""Workspace roles and the permission matrix (single source of truth; mirrored by RLS policies)."""

from __future__ import annotations

ROLES = ("owner", "admin", "editor", "commenter", "viewer")
RANK = {r: i for i, r in enumerate(reversed(ROLES))}  # viewer=0 … owner=4

ACTIONS: dict[str, str] = {
    "read": "viewer",
    "comment": "commenter",
    "edit_items": "editor",
    "delete_items": "editor",
    "manage_collections": "editor",
    "run_workflows": "editor",
    "create_share_links": "admin",
    "manage_members": "admin",
    "manage_connectors": "admin",
    "publish_to_community": "admin",
    "export": "editor",
    "change_visibility": "owner",
    "delete_workspace": "owner",
    "transfer_ownership": "owner",
}


def can(role: str | None, action: str) -> bool:
    if role not in RANK:
        return False
    need = ACTIONS.get(action)
    return need is not None and RANK[role] >= RANK[need]


def can_assign(actor_role: str, target_role: str) -> bool:
    """Admins can assign up to editor; only owners can make admins. Nobody assigns 'owner' (use transfer)."""
    if target_role == "owner":
        return False
    if actor_role == "owner":
        return True
    return actor_role == "admin" and RANK[target_role] < RANK["admin"]


def matrix() -> dict[str, dict[str, bool]]:
    return {a: {r: can(r, a) for r in ROLES} for a in ACTIONS}
