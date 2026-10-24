import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteTemplatesView } from "@/components/code/site-templates-view";

export const metadata: Metadata = { title: "Build a website", description: "Choose one of four website templates, describe your idea, and the coding agent builds it." };

export default function BuildWebsitePage() {
  return (
    <Suspense>
      <SiteTemplatesView />
    </Suspense>
  );
}
