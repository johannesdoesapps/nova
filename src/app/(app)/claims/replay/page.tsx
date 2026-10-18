import type { Metadata } from "next";
import { Suspense } from "react";
import { ReplayView } from "@/components/research/replay-view";

export const metadata: Metadata = { title: "Research Replay" };

export default function ReplayPage() {
  return (
    <Suspense>
      <ReplayView />
    </Suspense>
  );
}
