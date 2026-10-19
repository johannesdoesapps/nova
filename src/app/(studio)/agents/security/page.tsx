import type { Metadata } from "next";
import { SecurityView } from "@/components/security/security-view";

export const metadata: Metadata = {
  title: "Security Team",
  description: "Nova Sentinel, Threat Hunter and Code Guardian: website checks, log investigation and secure code review.",
};

export default function SecurityPage() {
  return <SecurityView />;
}
