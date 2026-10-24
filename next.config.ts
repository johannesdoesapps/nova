import type { NextConfig } from "next";

// Cache Components is intentionally left off for the MVP: almost every page
// reads the Supabase session, so standard dynamic rendering is the simplest
// reliable model. Revisit once the data layer is stable.
/**
 * Content-Security-Policy: what pages may load and where they may send data.
 * Scripts and styles come only from this site (Next.js needs its own inline
 * scripts, so 'unsafe-inline' stays; "eval" only in development). Images may
 * be anywhere https (avatars, images in replies). The only other site the
 * browser talks to is Supabase, for sign-in. The Code preview is a frame on
 * the workspace computer's own https address. Nothing may embed Orbis.
 */
function contentSecurityPolicy(): string {
  const supabase = (() => {
    try {
      return new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").origin;
    } catch {
      return "";
    }
  })();
  const dev = process.env.NODE_ENV !== "production";
  const rules: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...(supabase ? [supabase, supabase.replace(/^https:/, "wss:")] : []), ...(dev ? ["ws:"] : [])],
    "media-src": ["'self'", "blob:", "data:"],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'self'", "https:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
  };
  return [...Object.entries(rules).map(([k, v]) => `${k} ${v.join(" ")}`), ...(dev ? [] : ["upgrade-insecure-requests"])].join("; ");
}

/** The website template pages: their own styles, photos and fonts only, framed only by Orbis, sandboxed even when opened directly. */
const TEMPLATE_CSP = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // "/" is the public homepage; the app itself starts at /home. The older
  // workspace pages still exist in src/app/(app); remove an entry here to bring one back.
  async redirects() {
    const legacy = [
      "/dashboard", "/search", "/models", "/community", "/graph",
      "/integrations", "/radar", "/simulator", "/settings/:path*", "/claims/:path*",
      "/intel/:path*", "/lab/:path*", "/workspaces/:path*",
    ];
    return [
      // Supabase falls back to the bare Site URL with ?code= when a redirect
      // address isn't allow-listed; finish the sign-in instead of dropping it.
      { source: "/", has: [{ type: "query" as const, key: "code" }], destination: "/auth/callback", permanent: false },
      { source: "/", has: [{ type: "query" as const, key: "error" }], destination: "/auth/callback", permanent: false },
      { source: "/battle", destination: "/arena", permanent: false },
      // Research projects became missions (same records); /projects itself is now the projects overview.
      { source: "/projects/:id", destination: "/missions/:id", permanent: false },
      { source: "/:path(signup|sign-up|register)", destination: "/login?mode=signup", permanent: false },
      ...legacy.map((source) => ({ source, destination: "/chat", permanent: false })),
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        // Everything except the website templates' sample pages, which have their own rules below.
        source: "/((?!site-templates/).*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          // Voice input in the chat composer needs the microphone on ORBIS's own pages.
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
          { key: "Content-Security-Policy", value: contentSecurityPolicy() },
        ],
      },
      {
        // The website templates (public/site-templates): static sample pages shown in a sandboxed frame on
        // Orbis's own pages only. No scripts, forms or outside requests; fonts are readable cross-origin
        // because a sandboxed frame has no origin of its own.
        source: "/site-templates/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "X-Robots-Tag", value: "noindex" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Content-Security-Policy", value: TEMPLATE_CSP },
        ],
      },
      {
        // API responses and auth redirects are never search results.
        source: "/:dir(api|auth)/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ];
  },
};

export default nextConfig;
