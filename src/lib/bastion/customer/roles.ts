/**
 * Who may do what in a Bastion workspace. A workspace is one Orbis account and everything it owns (agents,
 * projects, connected services, findings). Its owner may give people in the same team a role on it. Platform
 * Security Administrators (Orbis administrators) manage Bastion Core from the Platform tab; that capability is
 * never a workspace role and can't be assigned here.
 */

export const WORKSPACE_ROLES = ["owner", "security_admin", "developer", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
/** Roles an owner can give someone else. */
export const ASSIGNABLE_ROLES = ["security_admin", "developer", "viewer"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

export const ROLE_LABEL: Record<WorkspaceRole, string> = { owner: "Workspace owner", security_admin: "Security administrator", developer: "Developer", viewer: "Viewer / auditor" };
export const ROLE_NOTE: Record<WorkspaceRole, string> = {
  owner: "Everything in this workspace, including roles and revoking connected services.",
  security_admin: "Policies, findings, assessments and pausing agents. Can't change roles or revoke connected services.",
  developer: "Sees findings and inventories, runs checks and works findings through to a re-check. No policies, no audit log.",
  viewer: "Read-only: overview, findings, inventories, policies and the audit log.",
};

export const PERMISSIONS = ["view", "audit_view", "assess", "findings_triage", "findings_manage", "policies_manage", "agents_manage", "integrations_revoke", "roles_manage", "access_review"] as const;
export type Permission = (typeof PERMISSIONS)[number];

const MATRIX: Record<WorkspaceRole, Permission[]> = {
  owner: [...PERMISSIONS],
  security_admin: ["view", "audit_view", "assess", "findings_triage", "findings_manage", "policies_manage", "agents_manage", "access_review"],
  developer: ["view", "assess", "findings_triage"],
  viewer: ["view", "audit_view"],
};

export const can = (role: WorkspaceRole | null, p: Permission) => !!role && MATRIX[role].includes(p);
export const permissionsOf = (role: WorkspaceRole) => [...MATRIX[role]];
