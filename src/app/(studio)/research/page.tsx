import type { Metadata } from "next";
import { ResearchHome } from "@/components/research/deep-research";

export const metadata: Metadata = { title: "Deep Research", description: "Multi-step web research with a plan, progress and a report where every citation links to the passage it came from." };

export default function ResearchPage() {
  return <ResearchHome />;
}
