import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/seo";

/**
 * Public pages are open to crawlers. App screens carry a noindex tag (they must
 * stay crawlable for search engines to see it); API and auth routes are blocked.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/auth/"] }],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
