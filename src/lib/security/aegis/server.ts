import "server-only";
import { listFindings, listRuns, listTargets } from "@/lib/db/security";
import type { ServerSupabase } from "@/lib/supabase/server";
import { fetchKev } from "../hunt/intel";
import type { AegisFinding, AegisRun } from "./model";
import { assembleAegis, type AegisEvent, type AegisInput, type AegisState } from "./state";

/** Load the user's own security data and assemble Aegis's state. Read-only. */
export async function loadAegis(db: ServerSupabase, userId: string, opts: { bastion?: AegisInput["bastion"] } = {}): Promise<AegisState> {
  const [findings, runs, targets, events] = await Promise.all([
    listFindings(db, userId, { sort: "recent", includeDuplicates: true }),
    listRuns(db, userId, 120),
    listTargets(db, userId),
    db.from("security_audit").select("action,detail,created_at").eq("user_id", userId).like("action", "aegis.%").order("created_at", { ascending: true }).limit(2000),
  ]);
  let kev: AegisInput["kev"] = { cves: new Map(), available: false, retrievedAt: null };
  try {
    const catalog = await fetchKev({ signal: AbortSignal.timeout(8_000) });
    kev = { cves: new Map(catalog.entries.map((e) => [e.cveID.toUpperCase(), { ransomware: /known/i.test(e.knownRansomwareCampaignUse ?? "") }])), available: true, retrievedAt: catalog.retrievedAt };
  } catch {
    /* shown as "not available" in coverage */
  }
  return assembleAegis({
    findings: findings as unknown as AegisFinding[],
    runs: runs.filter((r) => r.agent !== "coordinated") as unknown as AegisRun[],
    verifiedHosts: targets.filter((t) => t.verified_at).map((t) => t.hostname),
    events: (events.data ?? []) as AegisEvent[],
    kev,
    abuseIpdb: !!(process.env.ABUSEIPDB_API_KEY ?? "").trim(),
    bastion: opts.bastion ?? null,
  });
}
