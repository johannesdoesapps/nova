import type { Metadata } from "next";
import { WorkforceView } from "@/components/workforce/workforce-view";

export const metadata: Metadata = { title: "Workforce", description: "Orbis's internal AI engineering workforce." };

export default function WorkforcePage() {
  return <WorkforceView />;
}
