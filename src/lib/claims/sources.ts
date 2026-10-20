import { hash } from "./text";
import type { ReliabilityIndicators, SourceInput, SourceRecord, SourceType } from "./types";

const RULES: [SourceType, RegExp][] = [
  ["government", /(\.gov(\.[a-z]{2})?|\.mil|\.gouv\.[a-z]+|\.gob\.[a-z]+|europa\.eu|who\.int|un\.org|oecd\.org|worldbank\.org|imf\.org)$/],
  ["preprint", /(arxiv\.org|biorxiv\.org|medrxiv\.org|ssrn\.com|osf\.io|researchsquare\.com)$/],
  ["academic", /(\.edu|\.ac\.[a-z]{2}|doi\.org|nature\.com|science\.org|sciencedirect\.com|springer\.com|wiley\.com|thelancet\.com|nejm\.org|bmj\.com|jamanetwork\.com|plos\.org|pubmed\.ncbi\.nlm\.nih\.gov|ncbi\.nlm\.nih\.gov|jstor\.org|acm\.org|ieee\.org|cell\.com|frontiersin\.org|mdpi\.com)$/],
  ["reference", /(wikipedia\.org|britannica\.com|merriam-webster\.com|investopedia\.com)$/],
  ["news", /(reuters\.com|apnews\.com|bbc\.co\.uk|bbc\.com|nytimes\.com|ft\.com|wsj\.com|theguardian\.com|bloomberg\.com|washingtonpost\.com|economist\.com|npr\.org|cnn\.com|aljazeera\.com|axios\.com|theverge\.com|techcrunch\.com|wired\.com|arstechnica\.com|cnbc\.com|forbes\.com)$/],
  ["blog_forum", /(medium\.com|substack\.com|reddit\.com|quora\.com|blogspot\.com|wordpress\.com|x\.com|twitter\.com|facebook\.com|linkedin\.com|tiktok\.com|youtube\.com|stackexchange\.com|stackoverflow\.com|news\.ycombinator\.com|tumblr\.com)$/],
];

export function publisherOf(url: string | null | undefined): string {
  if (!url) return "user-provided";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export function classifySourceType(url: string | null | undefined): SourceType {
  if (!url) return "user_provided";
  const host = publisherOf(url);
  for (const [type, re] of RULES) if (re.test(host)) return type;
  if (/^(blog|community|forum)\./.test(host)) return "blog_forum";
  return "unknown";
}

const TYPE_NOTES: Partial<Record<SourceType, string>> = {
  preprint: "Preprint — not yet peer reviewed.",
  blog_forum: "Blog, forum or social post — check who is speaking and what they cite.",
  unknown: "Publisher type not recognised — inspect the page yourself.",
  user_provided: "Pasted by the user — provenance is whatever the user knows about it.",
  reference: "Tertiary reference — good for orientation, cite the primary source for key claims.",
};

export function buildSource(input: SourceInput, position: number, now: string): SourceRecord {
  const index = input.index ?? position + 1;
  const url = input.url ?? null;
  const contentKind = input.contentKind ?? (url ? "snippet" : "user_pasted");
  const sourceType = classifySourceType(url);
  const published = input.publishedAt ? new Date(input.publishedAt) : null;
  const validDate = published && !Number.isNaN(published.getTime()) ? published : null;
  const ageDays = validDate ? Math.max(0, Math.floor((new Date(now).getTime() - validDate.getTime()) / 86_400_000)) : null;

  const flags: string[] = [];
  if (contentKind === "snippet") flags.push("Only a search snippet was read, not the full page.");
  if (!validDate) flags.push("No publication date found.");
  else if (ageDays !== null && ageDays > 3 * 365) flags.push(`Published ${Math.floor(ageDays / 365)} years ago.`);
  if (url && !url.startsWith("https://")) flags.push("Not served over HTTPS.");
  if (input.text.trim().length < 200) flags.push("Very little text available to check against.");
  const typeNote = TYPE_NOTES[sourceType];
  if (typeNote) flags.push(typeNote);

  const reliability: ReliabilityIndicators = {
    sourceType,
    hasDate: Boolean(validDate),
    ageDays,
    https: Boolean(url?.startsWith("https://")),
    contentKind,
    textLength: input.text.length,
    flags,
  };

  return {
    id: `S${index}`,
    index,
    url,
    title: (input.title ?? "").trim() || publisherOf(url),
    publisher: publisherOf(url),
    author: input.author ?? null,
    publishedAt: validDate ? validDate.toISOString() : null,
    retrievedAt: now,
    contentKind,
    text: input.text,
    contentHash: hash(input.text),
    reliability,
    provenance: [
      url
        ? {
            at: now,
            actor: input.provider ? "search_provider" : "user",
            action: input.provider ? `Retrieved by ${input.provider} web search` : "URL supplied by the user",
            detail: url,
          }
        : { at: now, actor: "user", action: "Text pasted by the user" },
      { at: now, actor: "orbis", action: `Content fingerprinted (${contentKind.replace("_", " ")}, ${input.text.length} chars)`, detail: `hash ${hash(input.text)}` },
    ],
  };
}
