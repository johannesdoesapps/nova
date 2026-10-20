/** Remove secrets from anything that will be logged, stored, shown or sent to a model. */

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\b[sr]k_live_[A-Za-z0-9]{20,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:sb_secret|sbp)_[A-Za-z0-9_-]{20,}/g,
];

const ENV_SECRETS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "XAI_API_KEY", "DEEPSEEK_API_KEY", "HUGGINGFACE_API_KEY", "SEARCH_API_KEY", "GITHUB_TOKEN", "ABUSEIPDB_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "VERCEL_OIDC_TOKEN", "ORBIS_SANDBOX_TOKEN", "ORBIS_ENGINE_SECRET"];

export function redact(text: string): string {
  let out = text;
  for (const k of ENV_SECRETS) {
    const v = (typeof process !== "undefined" ? process.env[k] : undefined)?.trim();
    if (v && v.length >= 8) out = out.split(v).join(`[redacted ${k}]`);
  }
  for (const re of PATTERNS) out = out.replace(re, "[redacted secret]");
  return out;
}

/** Keep the end of long tool output, where failures usually are. */
export function tail(text: string, max = 6000): string {
  const t = redact(text.replace(/\x1b\[[0-9;]*m/g, ""));
  return t.length <= max ? t : `…(${t.length - max} earlier characters omitted)\n${t.slice(-max)}`;
}
