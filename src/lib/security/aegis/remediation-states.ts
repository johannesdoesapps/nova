/**
 * Remediation statuses and the transitions a person may make (pure, small: the command center imports it).
 * "Verified", "Partially resolved" and "Failed" come only from re-check evidence (workflow.ts).
 */

export const REMEDIATION_STATUSES = ["proposed", "approved", "in_progress", "verification_required", "verified", "partially_resolved", "failed", "rolled_back"] as const;
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number];
export const REMEDIATION_LABEL: Record<RemediationStatus, string> = {
  proposed: "Proposed",
  approved: "Approved",
  in_progress: "In progress",
  verification_required: "Verification required",
  verified: "Verified",
  partially_resolved: "Partially resolved",
  failed: "Failed",
  rolled_back: "Rolled back",
};
/** Statuses a person may set. The outcome statuses come only from re-check evidence. */
export const PERSON_STATUSES: RemediationStatus[] = ["proposed", "approved", "in_progress", "verification_required", "rolled_back"];
const ALLOWED: Record<RemediationStatus, RemediationStatus[]> = {
  proposed: ["approved", "rolled_back"],
  approved: ["in_progress", "verification_required", "rolled_back"],
  in_progress: ["verification_required", "rolled_back"],
  verification_required: ["in_progress", "rolled_back"],
  verified: ["rolled_back", "in_progress"],
  partially_resolved: ["in_progress", "verification_required", "rolled_back"],
  failed: ["in_progress", "verification_required", "rolled_back"],
  rolled_back: ["proposed", "approved"],
};

export function canTransition(from: RemediationStatus | null, to: RemediationStatus): string | null {
  if (!PERSON_STATUSES.includes(to)) return `"${REMEDIATION_LABEL[to]}" is set by a re-check, not by hand: re-check the findings after the fix is applied.`;
  if (from === null) return to === "proposed" || to === "approved" ? null : "Start a remediation as Proposed or Approved.";
  return ALLOWED[from].includes(to) ? null : `Can't go from ${REMEDIATION_LABEL[from]} to ${REMEDIATION_LABEL[to]}.`;
}
