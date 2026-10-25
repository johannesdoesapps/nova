import { customerPolicySchema, DEFAULT_CUSTOMER_POLICY, type CustomerPolicy, type PolicyVersion } from "./policy";

/**
 * Bastion's records live in the workspace's security audit trail (security_audit: append-only, row-level
 * security per account — nobody can change or delete a row through the API). Orbis signs every record it writes
 * with a server-only key, so a row added some other way (e.g. directly with the account's own database session)
 * is shown as unverified and never counts as a policy, a decision or a verification. Pure: the signing function
 * is passed in.
 */

export type Mac = (data: string) => string | null;
export type Integrity = "signed" | "unsigned" | "invalid";

export interface AuditRow {
  id?: number;
  user_id?: string;
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
}

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
        )
      : v;

/** What's signed: the owner, the action and the detail (without its signature), in a stable order. */
export function canonical(userId: string, action: string, detail: Record<string, unknown>): string {
  const { sig: _s, ...rest } = detail;
  void _s;
  return JSON.stringify([userId, action, sortKeys(rest)]);
}

export function signDetail(mac: Mac, userId: string, action: string, detail: Record<string, unknown>): Record<string, unknown> {
  const sig = mac(canonical(userId, action, detail));
  return sig ? { ...detail, sig } : detail;
}

export function integrityOf(mac: Mac, userId: string, row: AuditRow): Integrity {
  const sig = row.detail?.sig;
  if (typeof sig !== "string") return "unsigned";
  const want = mac(canonical(userId, row.action, row.detail));
  if (!want || want.length !== sig.length) return "invalid";
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0 ? "signed" : "invalid";
}

/** The workspace's current policy: the newest signed, valid "bastion.policy" record (defaults when there's none). */
export function latestPolicy(mac: Mac, userId: string, rows: AuditRow[]): { current: PolicyVersion; history: PolicyVersion[]; rejected: number } {
  const history: PolicyVersion[] = [];
  let rejected = 0;
  for (const r of [...rows].filter((x) => x.action === "bastion.policy").sort((a, b) => b.created_at.localeCompare(a.created_at))) {
    if (integrityOf(mac, userId, r) !== "signed") {
      rejected++;
      continue;
    }
    const p = customerPolicySchema.safeParse(r.detail.policy);
    if (!p.success) {
      rejected++;
      continue;
    }
    history.push({
      version: Number(r.detail.version) || history.length + 1,
      at: r.created_at,
      by: String(r.detail.actor ?? ""),
      note: typeof r.detail.note === "string" ? r.detail.note : null,
      summary: String(r.detail.summary ?? ""),
      policy: p.data,
    });
  }
  const current = history[0] ?? { version: 0, at: "", by: "", note: null, summary: "Defaults (no workspace policy saved)", policy: DEFAULT_CUSTOMER_POLICY };
  return { current, history, rejected };
}

export const isPolicy = (p: unknown): p is CustomerPolicy => customerPolicySchema.safeParse(p).success;
