import type { MetadataRoute } from "next";
import { FEATURES, GUIDES } from "@/content/site";
import { absoluteUrl } from "@/lib/seo";

/** Public, indexable pages only. App screens (chat, agents, admin…) are excluded and marked noindex. */
export default function sitemap(): MetadataRoute.Sitemap {
  const page = (path: string, priority: number, changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] = "monthly") => ({
    url: absoluteUrl(path),
    changeFrequency,
    priority,
  });
  return [
    page("/", 1, "weekly"),
    page("/features", 0.8),
    ...FEATURES.map((f) => page(`/features/${f.slug}`, 0.8)),
    page("/pricing", 0.7),
    page("/docs", 0.7),
    ...GUIDES.map((g) => page(`/docs/${g.slug}`, 0.6)),
    page("/security", 0.5),
    page("/privacy", 0.3, "yearly"),
    page("/terms", 0.3, "yearly"),
    page("/cookies", 0.3, "yearly"),
  ];
}
