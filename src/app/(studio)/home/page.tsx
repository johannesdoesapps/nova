import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import { Studio } from "@/components/studio/studio";

export const metadata: Metadata = { title: "Home", description: "Your Orbis home: ask anything, pick up recent conversations and projects, and plan your day." };

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f2ec" },
    { media: "(prefers-color-scheme: dark)", color: "#17171b" },
  ],
};

export default function HomePage() {
  return (
    <Suspense>
      <Studio home />
    </Suspense>
  );
}
