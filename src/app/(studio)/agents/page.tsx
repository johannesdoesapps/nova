import type { Metadata } from "next";
import { AgentsView } from "@/components/agents/agents-view";

export const metadata: Metadata = {
  title: "Agents",
  description: "Specialized AI assistants with their own instructions, tools and conversation history.",
};

export default function AgentsPage() {
  return <AgentsView />;
}
