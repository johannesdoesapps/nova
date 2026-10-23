/** The header's links: the three main products, then the pages people check before signing up. */
export const NAV = [
  { href: "/features/ai-assistant", label: "Chat" },
  { href: "/features/ai-coding-assistant", label: "Code" },
  { href: "/features/ai-agents", label: "Agents" },
  { href: "/pricing", label: "Pricing" },
  { href: "/docs", label: "Docs" },
  { href: "/security", label: "Security" },
];

/** New accounts and sign-ins land on the home: recent work, the day, and a prompt box. */
export const SIGN_UP_HREF = "/login?mode=signup&next=%2Fhome";
export const SIGN_IN_HREF = "/login?next=%2Fhome";

/**
 * "Start building free": sign up (or sign in), then straight to Code's website builder. With an idea id, its
 * example request is already in the box to edit or send.
 */
export function buildHref(idea?: string): string {
  const next = idea ? `/code?idea=${encodeURIComponent(idea)}` : "/code";
  return `/login?mode=signup&next=${encodeURIComponent(next)}`;
}
export const BUILD_HREF = buildHref();
