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
      "/", "/dashboard", "/search", "/battle", "/models", "/discover", "/community", "/graph",
      "/integrations", "/radar", "/simulator", "/settings/:path*", "/projects/:path*", "/claims/:path*",
      "/intel/:path*", "/lab/:path*", "/workspaces/:path*",
    ];
    return legacy.map((source) => ({ source, destination: "/chat", permanent: false }));
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
