/**
 * Central, typed access to configuration. Server-side values are only read
 * inside server modules; the public Supabase values are safe for the browser.
 */

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function int(v: string | undefined, fallback: number, min = 1, max = 100_000): number {
  const n = Number.parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const publicEnv = {
  supabaseUrl: clean(process.env.NEXT_PUBLIC_SUPABASE_URL),
  supabaseKey:
    clean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) ??
    clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  siteUrl: clean(process.env.NEXT_PUBLIC_SITE_URL) ?? "http://localhost:3000",
};

export function isSupabaseConfigured(): boolean {
  return Boolean(publicEnv.supabaseUrl && publicEnv.supabaseKey);
}

/** Server-only settings. Never import the values into client components. */
export function serverEnv() {
  return {
    openaiKey: clean(process.env.OPENAI_API_KEY),
    openaiBaseUrl: clean(process.env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
    huggingfaceKey: clean(process.env.HUGGINGFACE_API_KEY),
    searchProvider: (clean(process.env.SEARCH_PROVIDER) ?? "tavily").toLowerCase() as
      | "tavily"
      | "brave"
      | string,
    searchKey: clean(process.env.SEARCH_API_KEY),
    modelsJson: clean(process.env.NOVARA_MODELS),
    maxCompareModels: int(process.env.NOVARA_MAX_COMPARE_MODELS, 3, 2, 6),
    dailyRequestLimit: int(process.env.NOVARA_DAILY_REQUEST_LIMIT, 200),
    ratePerMinute: int(process.env.NOVARA_RATE_LIMIT_PER_MINUTE, 20, 1, 1000),
    sentryDsn: clean(process.env.SENTRY_DSN),
    privacyProfilesJson: clean(process.env.NOVARA_PRIVACY_PROFILES),
    trialSecretSet: Boolean(clean(process.env.NOVARA_TRIAL_SECRET)),
  };
}

export type IntegrationStatus = {
  id: "supabase" | "openai" | "huggingface" | "search" | "sentry";
  label: string;
  configured: boolean;
  envVars: string[];
  purpose: string;
};

/** Safe-to-display integration status (booleans only, never values). */
export function integrationStatus(): IntegrationStatus[] {
  const env = serverEnv();
  return [
    {
      id: "supabase",
      label: "Supabase",
      configured: isSupabaseConfigured(),
      envVars: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"],
      purpose: "Accounts, saved conversations, projects and comparisons",
    },
    {
      id: "openai",
      label: "OpenAI",
      configured: Boolean(env.openaiKey),
      envVars: ["OPENAI_API_KEY"],
      purpose: "Chat, search answers and OpenAI models in Model Battle",
    },
    {
      id: "huggingface",
      label: "Hugging Face",
      configured: Boolean(env.huggingfaceKey),
      envVars: ["HUGGINGFACE_API_KEY"],
      purpose: "Open-model inference via Inference Providers; higher Hub rate limits",
    },
    {
      id: "search",
      label: `Web search (${env.searchProvider})`,
      configured: Boolean(env.searchKey) && ["tavily", "brave"].includes(env.searchProvider),
      envVars: ["SEARCH_PROVIDER", "SEARCH_API_KEY"],
      purpose: "Live web sources and citations for AI Search",
    },
    {
      id: "sentry",
      label: "Sentry",
      configured: Boolean(env.sentryDsn),
      envVars: ["SENTRY_DSN"],
      purpose: "Error monitoring (optional)",
    },
  ];
}
