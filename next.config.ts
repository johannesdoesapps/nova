import type { NextConfig } from "next";

// Cache Components is intentionally left off for the MVP: almost every page
// reads the Supabase session, so standard dynamic rendering is the simplest
// reliable model. Revisit once the data layer is stable.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The public site is the chat studio only. The older workspace pages still
  // exist in src/app/(app); remove an entry here to bring one back.
  async redirects() {
    const legacy = [
      "/", "/dashboard", "/search", "/models", "/discover", "/community", "/graph",
      "/integrations", "/radar", "/simulator", "/settings/:path*", "/projects/:path*", "/claims/:path*",
      "/intel/:path*", "/lab/:path*", "/workspaces/:path*",
    ];
    return [
      // Supabase falls back to the bare Site URL with ?code= when a redirect
      // address isn't allow-listed; finish the sign-in instead of dropping it.
      { source: "/", has: [{ type: "query" as const, key: "code" }], destination: "/auth/callback", permanent: false },
      { source: "/", has: [{ type: "query" as const, key: "error" }], destination: "/auth/callback", permanent: false },
      { source: "/battle", destination: "/arena", permanent: false },
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
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
