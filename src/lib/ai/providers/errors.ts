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
