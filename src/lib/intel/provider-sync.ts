import "server-only";
import { serverEnv } from "../env";
import type { ModelWithStatus } from "../ai/types";

/**
 * Model-list sync against provider APIs, used to detect new, renamed and
 * retired models. Prices are only taken from an API when the provider
 * publishes them there (Hugging Face's router lists per-provider pricing);
 * otherwise they must be entered manually with a source URL.
 */

export interface ProviderListing {
  provider: "openai" | "huggingface";
  ok: boolean;
  error: string | null;
  fetchedAt: string;
  listed: number;
  missingFromProvider: string[];
  notInRegistry: string[];
  reportedPrices: { providerModelId: string; host: string; inputPer1M: number | null; outputPer1M: number | null; contextLength: number | null }[];
}

async function getJson(url: string, key: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

type HfModel = { id: string; providers?: { provider?: string; pricing?: { input?: number; output?: number }; context_length?: number }[] };

export async function syncProviders(registry: ModelWithStatus[]): Promise<ProviderListing[]> {
  const env = serverEnv();
  const now = new Date().toISOString();
  const out: ProviderListing[] = [];
  const targets: { provider: "openai" | "huggingface"; key: string | undefined; url: string }[] = [
    { provider: "openai", key: env.openaiKey, url: `${env.openaiBaseUrl.replace(/\/$/, "")}/models` },
    { provider: "huggingface", key: env.huggingfaceKey, url: "https://router.huggingface.co/v1/models" },
  ];
  for (const t of targets) {
    const mine = registry.filter((m) => m.provider === t.provider).map((m) => m.providerModelId);
    if (!t.key) {
      out.push({ provider: t.provider, ok: false, error: "Not configured", fetchedAt: now, listed: 0, missingFromProvider: [], notInRegistry: [], reportedPrices: [] });
      continue;
    }
    try {
      const j = (await getJson(t.url, t.key, AbortSignal.timeout(15_000))) as { data?: HfModel[] };
      const data = Array.isArray(j.data) ? j.data : [];
      const ids = new Set(data.map((d) => d.id));
      const reportedPrices =
        t.provider === "huggingface"
          ? data
              .filter((d) => mine.includes(d.id))
              .flatMap((d) =>
                (d.providers ?? []).map((p) => ({
                  providerModelId: d.id,
                  host: p.provider ?? "unknown",
                  inputPer1M: typeof p.pricing?.input === "number" ? p.pricing.input : null,
                  outputPer1M: typeof p.pricing?.output === "number" ? p.pricing.output : null,
                  contextLength: typeof p.context_length === "number" ? p.context_length : null,
                })),
              )
          : [];
      out.push({
        provider: t.provider,
        ok: true,
        error: null,
        fetchedAt: now,
        listed: data.length,
        missingFromProvider: mine.filter((id) => !ids.has(id)),
        notInRegistry: data.map((d) => d.id).filter((id) => !mine.includes(id)).slice(0, 25),
        reportedPrices,
      });
    } catch (err) {
      out.push({ provider: t.provider, ok: false, error: (err as Error).message.slice(0, 200), fetchedAt: now, listed: 0, missingFromProvider: [], notInRegistry: [], reportedPrices: [] });
    }
  }
  return out;
}
