import type { Metadata } from "next";
import { Suspense } from "react";
import { ClaimDnaView } from "@/components/research/claim-dna-view";

export const metadata: Metadata = { title: "Claim DNA" };

export default function ClaimsPage() {
  return (
    <Suspense>
      <ClaimDnaView />
    </Suspense>
  );
}
