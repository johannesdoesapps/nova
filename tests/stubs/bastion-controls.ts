/**
 * Bastion's controls as stored when nobody has changed anything: Core defaults and an empty workspace policy.
 * For tests whose fake database doesn't hold them (tests/bastion*.test.ts cover the real loading and failing closed).
 */
export async function defaultBastionControls(overrides: { controls?: () => unknown; workspace?: () => unknown } = {}) {
  const { DEFAULT_CONTROLS } = await import("@/lib/bastion/policy");
  const { DEFAULT_CUSTOMER_POLICY } = await import("@/lib/bastion/customer/policy");
  const ws = { current: { version: 0, at: "", by: "", note: null, summary: "", policy: DEFAULT_CUSTOMER_POLICY }, history: [], rejected: 0 };
  return {
    loadControls: async () => (overrides.controls ? overrides.controls() : DEFAULT_CONTROLS),
    invalidateControls: () => {},
    loadWorkspacePolicy: async () => overrides.workspace?.() ?? ws,
    invalidateWorkspacePolicy: () => {},
    bastionMac: () => null,
  };
}
