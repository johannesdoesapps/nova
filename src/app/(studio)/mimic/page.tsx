import type { Metadata } from "next";
import { Suspense } from "react";
import { MimicView } from "@/components/mimic/mimic-view";

export const metadata: Metadata = { title: "Mimic", description: "Show Mimic a task once; it learns it and does it for you, with checks and your approval." };

export default function MimicPage() {
  return (
    <Suspense>
      <MimicView />
    </Suspense>
  );
}
