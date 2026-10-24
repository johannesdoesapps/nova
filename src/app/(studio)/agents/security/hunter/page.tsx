import type { Metadata } from "next";
import { HunterWorkspace } from "@/components/security/hunter-workspace";

export const metadata: Metadata = {
  title: "Threat Hunter",
  description: "Investigations from your logs, threat intelligence for your stack, a detection lab and response tracking.",
  robots: { index: false },
};

export default function ThreatHunterPage() {
  return <HunterWorkspace />;
}
