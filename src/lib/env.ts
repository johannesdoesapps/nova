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

function num(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseFloat(v ?? "");
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
    anthropicKey: clean(process.env.ANTHROPIC_API_KEY),
    openaiKey: clean(process.env.OPENAI_API_KEY),
    openaiBaseUrl: clean(process.env.OPENAI_BASE_URL) ?? "https://api.openai.com/v1",
    geminiKey: clean(process.env.GEMINI_API_KEY),
    geminiBaseUrl: clean(process.env.GEMINI_BASE_URL) ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    xaiKey: clean(process.env.XAI_API_KEY),
    xaiBaseUrl: clean(process.env.XAI_BASE_URL) ?? "https://api.x.ai/v1",
    deepseekKey: clean(process.env.DEEPSEEK_API_KEY),
    deepseekBaseUrl: clean(process.env.DEEPSEEK_BASE_URL) ?? "https://api.deepseek.com/v1",
    huggingfaceKey: clean(process.env.HUGGINGFACE_API_KEY),
    searchProvider: (clean(process.env.SEARCH_PROVIDER) ?? "tavily").toLowerCase() as
      | "tavily"
      | "brave"
      | string,
    searchKey: clean(process.env.SEARCH_API_KEY),
    modelsJson: clean(process.env.NOVA_MODELS),
    maxCompareModels: int(process.env.NOVA_MAX_COMPARE_MODELS, 3, 2, 6),
    dailyRequestLimit: int(process.env.NOVA_DAILY_REQUEST_LIMIT, 200),
    ratePerMinute: int(process.env.NOVA_RATE_LIMIT_PER_MINUTE, 20, 1, 1000),
    sentryDsn: clean(process.env.SENTRY_DSN),
    privacyProfilesJson: clean(process.env.NOVA_PRIVACY_PROFILES),
    trialSecretSet: Boolean(clean(process.env.NOVA_TRIAL_SECRET)),
    /** Explicit opt-in to let anonymous visitors use paid AI in production without accounts. */
    allowGuestAi: clean(process.env.NOVA_ALLOW_GUEST_AI) === "1",
    /** Administrators have no usage allowance unless this is "false". */
    adminsUnlimited: clean(process.env.NOVA_ADMINS_UNLIMITED) !== "false",
    // Billing (Stripe) and the AI budget guard; see docs/BILLING.md.
    stripeSecretKey: clean(process.env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: clean(process.env.STRIPE_WEBHOOK_SECRET),
    /** Optional: a Stripe Price ID for Pro. Without it, checkout charges PLANS.pro.priceUsd monthly. */
    stripePriceId: clean(process.env.STRIPE_PRICE_ID),
    /** Server-only key that lets the payment webhook update subscriptions (bypasses RLS). */
    supabaseServiceRoleKey: clean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    /** Payment fees per charge, used for the profit-margin budget: percent and fixed USD. */
    paymentFeePercent: num(process.env.NOVA_PAYMENT_FEE_PERCENT, 2.9, 0, 20),
    paymentFeeFixedUsd: num(process.env.NOVA_PAYMENT_FEE_FIXED_USD, 0.3, 0, 5),
    /** Other monthly costs per paying subscriber (e.g. a share of hosting), in USD. */
    overheadPerSubscriberUsd: num(process.env.NOVA_OVERHEAD_PER_SUBSCRIBER_USD, 0, 0, 100),
    /** Monthly AI spend allowed per Free user, in USD. */
    freeAiBudgetUsd: num(process.env.NOVA_FREE_AI_BUDGET_USD, 0.25, 0, 100),
    /** Optional cap on the whole site's AI spend per calendar month, in USD. Unset means no cap. */
    monthlyAiBudgetUsd: process.env.NOVA_MONTHLY_AI_BUDGET_USD ? num(process.env.NOVA_MONTHLY_AI_BUDGET_USD, 0, 0, 1_000_000) : null,
  };
}

export type IntegrationStatus = {
  id: "supabase" | "anthropic" | "openai" | "google" | "xai" | "deepseek" | "huggingface" | "search" | "billing" | "sentry" | "engine";
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
      id: "anthropic",
      label: "Anthropic (Claude)",
      configured: Boolean(env.anthropicKey),
      envVars: ["ANTHROPIC_API_KEY"],
      purpose: "Claude models for chat, agents and search answers (default when set)",
    },
    {
      id: "openai",
      label: "OpenAI",
      configured: Boolean(env.openaiKey),
      envVars: ["OPENAI_API_KEY"],
      purpose: "Chat, search answers and OpenAI models in Model Battle",
    },
    {
      id: "google",
      label: "Google (Gemini)",
      configured: Boolean(env.geminiKey),
      envVars: ["GEMINI_API_KEY"],
      purpose: "Gemini models for chat and agents",
    },
    {
      id: "xai",
      label: "xAI (Grok)",
      configured: Boolean(env.xaiKey),
      envVars: ["XAI_API_KEY"],
      purpose: "Grok models for chat and agents",
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      configured: Boolean(env.deepseekKey),
      envVars: ["DEEPSEEK_API_KEY"],
      purpose: "DeepSeek models for chat and agents (Chinese and English)",
    },
    {
      id: "huggingface",
      label: "Hugging Face",
      configured: Boolean(env.huggingfaceKey),
      envVars: ["HUGGINGFACE_API_KEY"],
      purpose: "Open-model inference via Inference Providers; higher Hub rate limits",
    },
    {
      id: "billing",
      label: "Payments (Stripe)",
      configured: Boolean(env.stripeSecretKey && env.stripeWebhookSecret && env.supabaseServiceRoleKey),
      envVars: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "SUPABASE_SERVICE_ROLE_KEY"],
      purpose: "Pro subscriptions: checkout, billing portal and the webhook that activates plans",
    },
    {
      id: "search",
      label: `Web search (${env.searchProvider})`,
      configured: Boolean(env.searchKey) && ["tavily", "brave"].includes(env.searchProvider),
      envVars: ["SEARCH_PROVIDER", "SEARCH_API_KEY"],
      purpose: "Live web sources and citations for AI Search",
    },
    {
      id: "engine",
      label: "Orbis engine (Python)",
      configured: Boolean(clean(process.env.NOVA_ENGINE_SECRET)),
      envVars: ["NOVA_ENGINE_URL", "NOVA_ENGINE_SECRET"],
      purpose: "AI Lab workflows, Signal Radar, Workspaces, Community and Integrations",
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
