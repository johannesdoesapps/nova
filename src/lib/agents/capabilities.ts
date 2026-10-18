import "server-only";
import { serverEnv } from "../env";
import { ApiError } from "../http";
import { CAPABILITY_INFO, type AgentCapability, type CapabilityStatus } from "./types";

/**
 * What this deployment can actually do. Agents may only enable capabilities
 * that are implemented and configured here; the UI shows the rest as needing setup.
 */
export function capabilityStatus(): CapabilityStatus {
  const env = serverEnv();
  return {
    web_search: env.searchKey
      ? { available: true }
      : { available: false, reason: "Needs SEARCH_API_KEY (Tavily or Brave) on the server." },
    file_analysis: { available: true },
    data_analysis: { available: true },
    code_execution: { available: false, reason: "Needs a sandboxed code runner, which isn't set up in this deployment." },
  };
}

/** Reject saving an agent with a capability this deployment can't provide. */
export function assertCapabilitiesAvailable(caps: AgentCapability[]) {
  const status = capabilityStatus();
  const missing = caps.filter((c) => !status[c].available);
  if (missing.length) {
    throw new ApiError(
      "bad_request",
      `${missing.map((c) => CAPABILITY_INFO[c].label).join(", ")} isn't available here. ${status[missing[0]!].reason ?? ""}`.trim(),
    );
  }
}
