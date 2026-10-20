/**
 * Vercel Sandbox prices (https://vercel.com/docs/sandbox/pricing, checked
 * 2026-10-19): $0.128 per active CPU hour, $0.0212 per GB-hour of provisioned
 * memory, $0.60 per million sandbox creations. A code run uses 1 vCPU and 2 GB.
 */
export const SANDBOX_PRICES = { cpuHourUsd: 0.128, gbHourUsd: 0.0212, creationUsd: 0.6 / 1_000_000, vcpus: 1, memoryGb: 2 } as const;

/** Starting the VM, writing the program and stopping it, beyond the program's own run time. */
export const RUN_OVERHEAD_MS = 3_000;

/** Upper bound of a run's sandbox cost: CPU busy for the whole wall time, plus memory and the VM start. */
export function codeRunCostUsd(durationMs: number): number {
  const hours = Math.max(0, durationMs) / 3_600_000;
  const p = SANDBOX_PRICES;
  return Math.round((hours * (p.cpuHourUsd * p.vcpus + p.gbHourUsd * p.memoryGb) + p.creationUsd) * 1_000_000) / 1_000_000;
}

/** The most one run can cost at a given time limit. */
export function maxCodeRunCostUsd(seconds: number): number {
  return codeRunCostUsd(seconds * 1000 + RUN_OVERHEAD_MS);
}

/**
 * Code workspace computers use the same size (1 vCPU, 2 GB). Previews served
 * from them count as Sandbox data transfer ($0.15 per GB, same page); a
 * generous 2 MB a minute is allowed for that. Workspaces aren't persistent,
 * so there's no snapshot storage.
 */
export const WORKSPACE_TRANSFER_GB_PER_MINUTE = 0.002;
export const SANDBOX_TRANSFER_USD_PER_GB = 0.15;

/** The most one minute of workspace time can cost: CPU busy throughout, memory, preview traffic. */
export function workspaceMinuteCostUsd(): number {
  const p = SANDBOX_PRICES;
  return Math.round(((p.cpuHourUsd * p.vcpus + p.gbHourUsd * p.memoryGb) / 60 + WORKSPACE_TRANSFER_GB_PER_MINUTE * SANDBOX_TRANSFER_USD_PER_GB) * 1_000_000) / 1_000_000;
}

/** The most a block of workspace time can cost, including starting the computer. */
export function workspaceBlockCostUsd(minutes: number): number {
  return Math.round((minutes * workspaceMinuteCostUsd() + SANDBOX_PRICES.creationUsd) * 1_000_000) / 1_000_000;
}
