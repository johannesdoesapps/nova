import type { Metadata } from "next";
import { DirectoryView } from "@/components/agent-platform/directory-view";
import { CATALOGUE } from "@/lib/agent-platform/catalogue";

export const metadata: Metadata = { title: "Agent directory", description: "Every AI agent in Orbis: its role, boundaries, tools, dependencies and status." };

export default function AgentDirectoryPage() {
  return <DirectoryView catalogue={CATALOGUE} />;
}
