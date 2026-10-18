import type { ProviderId } from "./types";

/** Display names and setup steps for each provider (no secrets; safe for the browser). */
export const PROVIDER_INFO: Record<Exclude<ProviderId, "demo">, { label: string; short: string; envVar: string; keyUrl: string; steps: string }> = {
  anthropic: {
    label: "Anthropic",
    short: "A",
    envVar: "ANTHROPIC_API_KEY",
    keyUrl: "https://console.anthropic.com/settings/keys",
    steps: "Create an API key in the Anthropic Console, set a spending limit, then add it to your hosting environment as ANTHROPIC_API_KEY and redeploy.",
  },
  openai: {
    label: "OpenAI",
    short: "O",
    envVar: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com/api-keys",
    steps: "Create an API key on the OpenAI platform, set a usage limit, then add it to your hosting environment as OPENAI_API_KEY and redeploy.",
  },
  google: {
    label: "Google",
    short: "G",
    envVar: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    steps: "Create a Gemini API key in Google AI Studio, then add it to your hosting environment as GEMINI_API_KEY and redeploy.",
  },
  deepseek: {
    label: "DeepSeek",
    short: "DS",
    envVar: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com/api_keys",
    steps: "Create an API key on the DeepSeek platform and top up a small balance, then add it to your hosting environment as DEEPSEEK_API_KEY and redeploy.",
  },
  huggingface: {
    label: "Hugging Face",
    short: "HF",
    envVar: "HUGGINGFACE_API_KEY",
    keyUrl: "https://huggingface.co/settings/tokens",
    steps: "Create a fine-grained token with \"Make calls to Inference Providers\", then add it as HUGGINGFACE_API_KEY and redeploy.",
  },
};

export function providerLabel(p: ProviderId): string {
  return p === "demo" ? "Demo" : PROVIDER_INFO[p].label;
}
