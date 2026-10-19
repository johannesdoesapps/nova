import type { Metadata } from "next";
import { publicEnv } from "./env";

export const SITE_NAME = "NOVA";

/** The production address from configuration (NEXT_PUBLIC_SITE_URL), without a trailing slash. */
export function siteUrl(): string {
  return publicEnv.siteUrl.replace(/\/$/, "");
}

export function absoluteUrl(path: string): string {
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The generated social preview (src/app/opengraph-image.tsx); listed explicitly because a page's own openGraph replaces the inherited one. */
const OG_IMAGE = { url: "/opengraph-image", width: 1200, height: 630, alt: "NOVA — AI assistant and agent workspace" };

/** Metadata for a public page: unique title and description, canonical URL and social previews. */
export function pageMetadata({ title, description, path, absoluteTitle = false }: { title: string; description: string; path: string; absoluteTitle?: boolean }): Metadata {
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: SITE_NAME, title, description, url: path, locale: "en_US", images: [OG_IMAGE] },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE.url] },
  };
}

/** For signed-in app screens and other pages that shouldn't appear in search results. */
export const PRIVATE_ROBOTS: Metadata["robots"] = { index: false, follow: false, googleBot: { index: false, follow: false } };

/** Serialise JSON-LD safely inside a <script> tag. */
export function jsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
