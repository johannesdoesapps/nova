/** Where another page leaves an answer for the Verify page to check (sessionStorage, read once). */
export const VERIFY_PREFILL_KEY = "orbis:verify:prefill";

export function openInVerify(question: string, answer: string) {
  try {
    sessionStorage.setItem(VERIFY_PREFILL_KEY, JSON.stringify({ question, answer }));
  } catch {
    /* the page opens empty */
  }
}
