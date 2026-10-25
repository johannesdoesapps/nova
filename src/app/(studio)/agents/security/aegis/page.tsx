import type { Metadata } from "next";
import { AegisWorkspace } from "@/components/security/aegis-workspace";

export const metadata: Metadata = {
  title: "Aegis",
  description: "The security team's command center: prioritised risks, attack-path hypotheses, investigations, remediation and coverage across every security agent.",
  robots: { index: false },
};

export default function AegisPage() {
  return <AegisWorkspace />;
}
