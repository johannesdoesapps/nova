import type { Metadata } from "next";
import { WorkflowList } from "@/components/agent-platform/workflow-list";

export const metadata: Metadata = { title: "Workflows", description: "Agents working in sequence on one project, ending with your decision." };

export default function WorkflowsPage() {
  return <WorkflowList />;
}
