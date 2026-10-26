import "server-only";
import { gunzipSync, gzipSync } from "node:zlib";
import { fitReport, readStored } from "./report";
import type { ScanReport } from "./types";

/**
 * Website scan reports live in the run's stats (20 KB limit). The full report is stored gzip-compressed and
 * base64-encoded (a typical 25–40 KB report packs to well under 10 KB); only if that still doesn't fit is a shortened
 * copy stored instead, marked `trimmed`.
 */

export function packReport(report: ScanReport, budget: number): { reportGz: string } | { report: ScanReport } {
  const gz = gzipSync(Buffer.from(JSON.stringify(report), "utf8"), { level: 9 }).toString("base64");
  return gz.length + 20 <= budget ? { reportGz: gz } : { report: fitReport(report, budget) };
}

export function unpackReport(stats: Record<string, unknown>, runId: string): ScanReport | null {
  if (typeof stats.reportGz === "string") {
    try {
      return readStored(JSON.parse(gunzipSync(Buffer.from(stats.reportGz, "base64")).toString("utf8")) as ScanReport, runId);
    } catch {
      return null;
    }
  }
  return stats.report ? readStored(stats.report as ScanReport, runId) : null;
}
