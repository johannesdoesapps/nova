import type { Metadata } from "next";
import { CouncilView } from "@/components/council/council-view";

export const metadata: Metadata = { title: "Council", description: "Several AI models answer, review each other, and Orbis combines the result." };

export default function CouncilPage() {
  return <CouncilView />;
}
