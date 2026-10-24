import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { listFindings, listRuns } from "@/lib/db/security";
import { errorResponse } from "@/lib/http";
import { cvesIn, fetchKev, KEV_URL, matchKev } from "@/lib/security/hunt/intel";

export const maxDuration = 30;

/**
 * GET /api/security/intel — advisories from CISA's Known Exploited Vulnerabilities catalogue that touch the
 * user's actual stack: CVEs listed by their own dependency findings (verified matches) and products seen in
 * their website or code maps (leads; versions not checked). Says plainly when the catalogue can't be reached.
 */
export async function GET() {
  try {
    const auth = await requireUser();
    const [findings, runs] = await Promise.all([listFindings(auth.supabase, auth.user.id, { agent: "code_guardian", sort: "recent" }), listRuns(auth.supabase, auth.user.id, 60)]);
    const cves = findings
      .filter((f) => f.rule_id === "deps.osv" && !["fixed", "verified", "false_positive"].includes(f.status))
      .flatMap((f) => cvesIn(f.evidence.map((e) => e.source).join(" ")).map((cve) => ({ cve, where: `${f.title} (${f.asset})` })));
    const technologies = new Set<string>();
    for (const r of runs) {
      const surface = r.stats.surface as { tech?: string[] } | undefined;
      const map = r.stats.codeMap as { frameworks?: string[]; securityLibraries?: string[] } | undefined;
      for (const t of [...(surface?.tech ?? []), ...(map?.frameworks ?? []), ...(map?.securityLibraries ?? [])]) if (!/routes$/.test(t)) technologies.add(t);
    }
    const stack = { cves, technologies: [...technologies].slice(0, 60) };
    try {
      const catalog = await fetchKev({ signal: AbortSignal.timeout(12_000) });
      return NextResponse.json({
        source: { name: "CISA Known Exploited Vulnerabilities", url: KEV_URL, version: catalog.version, released: catalog.released, retrievedAt: catalog.retrievedAt, entries: catalog.entries.length },
        stack: { cves: cves.length, technologies: stack.technologies },
        advisories: matchKev(catalog, stack),
      });
    } catch (err) {
      return NextResponse.json({
        source: { name: "CISA Known Exploited Vulnerabilities", url: KEV_URL },
        stack: { cves: cves.length, technologies: stack.technologies },
        advisories: [],
        error: `The catalogue couldn't be reached: ${(err as Error).message}`.slice(0, 200),
      });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
