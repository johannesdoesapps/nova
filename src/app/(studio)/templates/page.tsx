import type { Metadata } from "next";
import { Suspense } from "react";
import { TemplatesPage } from "@/components/studio/templates-page";

export const metadata: Metadata = { title: "Templates", description: "Ready-made workflows for common tasks." };

export default function Templates() {
  return (
    <Suspense>
      <TemplatesPage />
    </Suspense>
  );
}
