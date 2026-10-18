import type { Metadata } from "next";
import { GitBranch } from "lucide-react";
import { ComingSoon } from "@/components/common/coming-soon";

export const metadata: Metadata = { title: "What-If Simulator" };

export default function SimulatorPage() {
  return (
    <ComingSoon
      icon={GitBranch}
      title="What-If Simulator"
      tagline="Compare best, base and worst-case scenarios for a decision."
      stage="Stage 4"
      planned={[
        "Describe a decision and define editable assumptions.",
        "Side-by-side scenario table with initial costs, recurring costs, risks and outcomes.",
        "Every figure labelled as user-provided, sourced, or model-estimated.",
        "Save scenarios to Research Projects.",
      ]}
      note="A decision-support tool, not financial, legal or medical advice. Projections will never be presented as predictions."
    />
  );
}
