import type { Metadata } from "next";
import { Suspense } from "react";
import { ArenaView } from "@/components/council/arena-view";

export const metadata: Metadata = { title: "Arena", description: "Compare AI models side by side on the same prompt." };

export default function ArenaPage() {
  return (
    <Suspense>
      <ArenaView />
    </Suspense>
  );
}
