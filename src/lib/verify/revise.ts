import type { ChatMessage } from "../ai/types";
import { categoryOf, CATEGORIES } from "./categories";
import type { ReviseRequest } from "./schema";

const strip = (s: string) => s.replace(/<\/?\s*(answer|findings|finding|source|system|instructions?)\b[^>]*>/gi, "[tag removed]");

export const REVISE_SYSTEM_PROMPT = `You revise an answer using the results of a source check.
Rules:
- Keep claims marked "Supported" and cite them with the source numbers given, like [1]. Cite only the numbered sources listed; never invent a source, URL or quote.
- For "Contradicted" claims: remove or correct them, using only what the listed evidence quotes say. If the evidence doesn't say what is correct, say the claim could not be confirmed.
- For "Sources disagree", "Insufficient evidence" and "Not checked" claims: keep them only if needed, and say plainly that they are unconfirmed.
- Don't add new factual claims that the findings don't cover.
- Keep the original structure and tone where you can.
End with a short "What changed" list (one line per change).`;

/** The prompt for a revised answer, with numbered sources taken only from the findings. */
export function buildReviseMessages(req: Pick<ReviseRequest, "question" | "answer" | "findings">): { messages: ChatMessage[]; sources: { n: number; title: string; url: string | null }[] } {
  const sources: { n: number; title: string; url: string | null }[] = [];
  const numberOf = (title: string, url: string | null) => {
    const hit = sources.find((s) => (url ? s.url === url : s.title === title && !s.url));
    if (hit) return hit.n;
    sources.push({ n: sources.length + 1, title, url });
    return sources.length;
  };
  const lines = req.findings.map((f, i) => {
    const label = CATEGORIES[categoryOf((f.status as Parameters<typeof categoryOf>[0]) ?? null)].short;
    const ev = f.evidence.map((e) => `   - [${numberOf(e.title, e.url)}] ${e.stance}${e.quote ? `: "${strip(e.quote)}"` : ""}`).join("\n");
    return `${i + 1}. (${label}) ${strip(f.text)}${ev ? `\n${ev}` : ""}`;
  });
  const sourceList = sources.map((s) => `[${s.n}] ${strip(s.title)}${s.url ? ` — ${s.url}` : ""}`).join("\n");
  return {
    sources,
    messages: [
      { role: "system", content: REVISE_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${req.question ? `Question: ${strip(req.question)}\n\n` : ""}<answer>\n${strip(req.answer)}\n</answer>\n\n<findings>\n${lines.join("\n")}\n</findings>\n\nSources you may cite:\n${sourceList || "(none — cite nothing)"}`,
      },
    ],
  };
}
