import type { Metadata } from "next";
import { Suspense } from "react";
import { MissionsView } from "@/components/missions/missions-view";

export const metadata: Metadata = { title: "Missions", description: "Turn goals into plans and tracked tasks." };

export default function MissionsPage() {
  return (
    <Suspense>
      <MissionsView />
    </Suspense>
  );
}
