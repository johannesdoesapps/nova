import { Suspense } from "react";
import type { Metadata, Viewport } from "next";
import { Studio } from "@/components/studio/studio";

export const metadata: Metadata = {
  title: "Chat",
  description: "Chat with Orbis: research, analysis, critique and code, with cited sources when the web is used.",
};

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

export default function ChatPage() {
  return (
    <Suspense>
      <Studio />
    </Suspense>
  );
}
