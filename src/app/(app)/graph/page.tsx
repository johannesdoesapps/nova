import type { Metadata } from "next";
import { Network } from "lucide-react";
import { ComingSoon } from "@/components/common/coming-soon";

export const metadata: Metadata = { title: "Knowledge Graph" };

export default function GraphPage() {
  return (
    <ComingSoon
      icon={Network}
      title="Knowledge Graph"
      tagline="See how your sources, claims and projects connect."
      stage="Stage 5"
      planned={[
        "Entities: topics, companies, people, models, papers, datasets, claims and sources.",
        "Relationships such as supports, contradicts, created by and mentioned in.",
        "Starts as a linked list of related items; a visual graph arrives once there is enough structured data.",
      ]}
    />
  );
}
