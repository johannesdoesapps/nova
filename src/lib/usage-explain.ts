/**
 * Why a request used the units it did, from its usage record: the model's units for a typical message,
 * how big this request really was (tokens the provider reported), and whether it was paid from extra
 * usage, refunded or not counted. Pure, so the Usage page and tests word it the same way; it explains
 * the recorded charge and never recomputes it.
 */

export interface ChargeRecord {
  feature: string;
  status: "success" | "error";
  /** Units recorded for the request (null: not recorded). */
  units: number | null;
  /** The model's units for a typical message, by the same rule the server charges with. */
  baseUnits: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  paidWithCredits: boolean;
  notCounted: boolean;
}

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 });

export function explainCharge(r: ChargeRecord): string {
  if (r.notCounted) return "Not counted: administrator accounts have no allowance.";
  if (r.feature === "code_workspace") return "Workspace computer time, counted in minutes (10-minute blocks) against your monthly workspace minutes, not in units.";
  if (r.feature === "code_run") return "A code run from a chat reply: counted against your monthly code runs, not in units.";
  if (r.status === "error" && !r.units) return "Not charged: the request failed before any reply.";
  if (r.units === null) return "No units were recorded for this request.";
  if (r.units === 0) return "Not charged: a background step that doesn't count toward your limits.";
  const paid = r.paidWithCredits ? " Paid from your extra usage, so it didn't count toward your plan's limits." : "";
  if (!r.baseUnits) return `Charged ${fmt(r.units)} units.${paid}`;
  const size = r.units / r.baseUnits;
  const tokens = r.inputTokens !== null && r.outputTokens !== null ? ` (${fmt(r.inputTokens)} tokens read, ${fmt(r.outputTokens)} written)` : "";
  const typical = `A typical message to this model uses ${fmt(r.baseUnits)} unit${r.baseUnits === 1 ? "" : "s"}`;
  if (Math.abs(size - 1) < 0.05) return `${typical}; this one was charged at that rate${tokens}.${paid}`;
  return `${typical}; this one was about ${fmt(Math.round(size * 10) / 10)}× that size${tokens}, so it used ${fmt(r.units)}.${paid}`;
}
