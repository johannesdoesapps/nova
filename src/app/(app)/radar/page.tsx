import type { Metadata } from "next";
import { Radar } from "lucide-react";
import { ComingSoon } from "@/components/common/coming-soon";

export const metadata: Metadata = { title: "Radar" };

export default function RadarPage() {
  return (
    <ComingSoon
      icon={Radar}
      title="NOVARA Radar"
      tagline="Track topics, competitors and model releases over time."
      stage="Stage 4"
      planned={[
        "Create monitoring tasks from a topic or query (the radar_tasks table already exists).",
        "Daily or weekly checks run by a scheduled job, within usage limits.",
        "Compare new findings with previous results and highlight what changed, with source links.",
        "Pause, resume and delete tasks; see the last successful check.",
      ]}
      note="Continuous monitoring is intentionally not part of the first MVP to avoid excessive polling and API costs."
    />
  );
}
