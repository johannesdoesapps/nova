import type { Metadata } from "next";
import { Suspense } from "react";
import { SecurityView } from "@/components/security/security-view";

export const metadata: Metadata = {
  title: "Security Team",
  description: "Eleven security agents that audit code, repositories, Vercel deployments and Cloudflare protection, verify findings and help fix them.",
};

export default function SecurityPage() {
  return (
    <Suspense>
      <SecurityView />
    </Suspense>
  );
}
