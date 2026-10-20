import "server-only";
import { getProvider, resolveModelChoice, withTimeout } from "@/lib/ai";
import { autoIdFor } from "@/lib/ai/platform";
import type { ModelWithStatus, Usage } from "@/lib/ai/types";
import { reportError } from "@/lib/observability";
import { recordRun } from "@/lib/usage";
import { connectorContext, type ConnectorContext, type Planner } from "./router";
import { listConnections, type Authed } from "./runtime";

/**
 * Connectors for one chat turn: the user's connections, a fast standard-tier
 * model as the planner, and the planner's usage recorded after the reply as
 * a helper call (its cost counts; it uses no message allowance).
 */
export async function chatConnectors(
  auth: Authed,
  message: string,
  opts: { firstIndex: number; timeZone?: string | null; signal?: AbortSignal },
): Promise<{ ctx: ConnectorContext | null; record: () => Promise<void> }> {
  let used: { model: ModelWithStatus; usage: Usage; text: string; ms: number } | null = null;
  const planner: Planner = async (system, user, signal) => {
    const choice = await resolveModelChoice(autoIdFor("quick"), { prompt: user, tiers: ["standard"] }).catch(() => null);
    if (!choice || choice.model.provider === "demo") return null;
    const started = performance.now();
    const r = await getProvider(choice.model.provider).generate({
      model: choice.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      maxOutputTokens: 500,
      temperature: 0,
      signal: withTimeout(12_000, signal),
    });
    used = { model: choice.model, usage: r.usage, text: r.text, ms: performance.now() - started };
    return { text: r.text };
  };
  let ctx: ConnectorContext | null = null;
  try {
    const rows = await listConnections(auth);
    ctx = await connectorContext(auth, message, rows, { ...opts, planner });
  } catch (err) {
    reportError(err, { where: "connectors.chat" });
  }
  return {
    ctx,
    async record() {
      if (!used) return;
      const u = used as { model: ModelWithStatus; usage: Usage; text: string; ms: number };
      await recordRun(auth, { model: u.model, prompt: "[connectors: choosing what to search]", response: u.text.slice(0, 2000), latencyMs: u.ms, usage: u.usage, status: "success", purpose: "connector_plan", auxiliary: true });
    },
  };
}
