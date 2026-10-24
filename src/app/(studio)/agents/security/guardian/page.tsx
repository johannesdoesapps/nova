import type { Metadata } from "next";
import { GuardianWorkspace } from "@/components/security/guardian-workspace";

export const metadata: Metadata = {
  title: "Code Guardian",
  description: "Engineering health of your code: defects, dependency compatibility, architecture, change impact and repairs.",
  robots: { index: false },
};

export default function CodeGuardianPage() {
  return <GuardianWorkspace />;
}
