import type { SiteDetails } from "./site-examples";
import { findEffect, type WebsiteEffectId } from "../templates/website-effects";

/** Where another page leaves a request for Code's start page to fill in (sessionStorage, read once). */
export const CODE_PREFILL_KEY = "orbis:code:prefill";

export interface CodePrefill {
  request: string;
  /** Optional website details, shown in the box's details. */
  details?: Partial<SiteDetails>;
  /** A new website project, or the user's most recently edited website (a new one when they have none). */
  target: "new:website" | "latest-website";
  /** An effect whose instructions file is copied into the project before the agent starts. */
  effect?: WebsiteEffectId;
}

export function openInCode(prefill: CodePrefill) {
  try {
    sessionStorage.setItem(CODE_PREFILL_KEY, JSON.stringify(prefill));
  } catch {
    /* Code opens with an empty box */
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** The request left for Code, once (it's removed when read). */
export function takeCodePrefill(): CodePrefill | null {
  try {
    const raw = sessionStorage.getItem(CODE_PREFILL_KEY);
    sessionStorage.removeItem(CODE_PREFILL_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const request = str(v.request, 8_000).trim();
    if (!request) return null;
    const d = (v.details ?? {}) as Record<string, unknown>;
    const details: Partial<SiteDetails> = { purpose: str(d.purpose, 300), audience: str(d.audience, 300), style: str(d.style, 300), sections: str(d.sections, 300) };
    const effect = typeof v.effect === "string" ? findEffect(v.effect)?.id : undefined;
    return { request, details, target: v.target === "latest-website" ? "latest-website" : "new:website", ...(effect && { effect }) };
  } catch {
    return null;
  }
}

/** The project a "latest website" request goes to: the most recently edited website, if there is one. */
export function latestWebsite<P extends { id: string; template: string; updatedAt: string }>(projects: P[]): P | undefined {
  return projects.filter((p) => p.template === "website").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}
