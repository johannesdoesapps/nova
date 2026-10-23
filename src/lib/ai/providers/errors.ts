import { alertOwner } from "../../alerts";
import { ApiError } from "../../http";

/**
 * What users see when a provider call fails: what happened and what to do,
 * never the provider's raw text (it can echo parts of API keys or settings).
 */
export function providerErrorMessage(name: string, status: number, detail: string): string {
  if (status === 429) return `${name} is busy right now. Try again shortly or choose another model.`;
  if (status === 401 || status === 403) return `${name} isn't available right now because of a configuration problem on this site. Choose another model; an administrator has been notified.`;
  if (status === 404) return `${name} isn't available from its provider right now. Choose another model.`;
  if (status === 413 || /context|too long|maximum.*tokens|prompt is too long/i.test(detail)) {
    return `This conversation is too long for ${name}. Start a new chat or choose a model with a longer context.`;
  }
  if (status >= 500) return `${name} had a problem answering (error ${status}). Try again in a moment or choose another model.`;
  return `${name} couldn't process this request (error ${status}). Try rephrasing it or choose another model.`;
}

/**
 * Billing stops reported by a provider: the account's prepaid balance is used up or a spend limit
 * was reached, so every request will fail until the owner acts. Codes and messages as documented by
 * Anthropic (platform.claude.com/docs/en/api/rate-limits) and OpenAI (api/docs/guides/spend-limits).
 */
export type BillingStop = "balance" | "spend_limit" | "usage_limit";

export function billingStop(status: number, code: string | null | undefined, message: string): BillingStop | null {
  const c = (code ?? "").toLowerCase();
  if (c === "credit_balance_exhausted" || c === "insufficient_quota" || /credit balance is too low/i.test(message)) return "balance";
  if (c === "organization_spend_limit_exceeded" || c === "project_spend_limit_exceeded" || c === "enforced_spend_limit_reached") return "spend_limit";
  if (/you have reached your (specified )?(workspace )?api usage limits/i.test(message)) return "spend_limit";
  if (c === "organization_usage_limit_exceeded") return "usage_limit";
  return null;
}

const STOP_TEXT: Record<BillingStop, string> = {
  balance: "its prepaid credit balance is used up. Add credits or turn on auto-reload in the provider's billing settings.",
  spend_limit: "a monthly spend limit was reached. Raise or remove the limit in the provider's billing settings, or wait for next month.",
  usage_limit: "the provider's approved monthly usage limit was reached. Request a higher limit in the provider's settings.",
};

/** The error users see for a billing stop, after telling the owner (at most once an hour per provider and kind). */
export function billingStopError(provider: string, modelName: string, stop: BillingStop): ApiError {
  alertOwner(
    `provider:${provider}:${stop}`,
    `Orbis: ${provider} requests are stopped`,
    `Requests to ${provider} are failing because ${STOP_TEXT[stop]}\n\nCustomers see "${modelName} is temporarily unavailable" and can choose a model from another provider until this is fixed.`,
  );
  return new ApiError("provider_unavailable", `${modelName} is temporarily unavailable. Choose a model from another provider, or try again later.`, { scope: "provider_billing" });
}
