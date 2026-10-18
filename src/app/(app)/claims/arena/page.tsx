import type { Metadata } from "next";
import { Suspense } from "react";
import { ArenaView } from "@/components/research/arena-view";

export const metadata: Metadata = { title: "Hypothesis Arena" };

export default function ArenaPage() {
  return (
    <Suspense>
      <ArenaView />
    </Suspense>
  );
}
