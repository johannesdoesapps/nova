import type { Metadata } from "next";
import { ActivityView } from "@/components/agent-platform/activity-view";

export const metadata: Metadata = { title: "Activity", description: "Every agent task: what's running, waiting for you, done or failed." };

export default function ActivityPage() {
  return <ActivityView />;
}
