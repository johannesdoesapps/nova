import type { Metadata } from "next";
import { WorkflowDetail } from "@/components/agent-platform/workflow-view";

export const metadata: Metadata = { title: "Workflow", description: "A multi-agent workflow: its steps, their tasks and your decision." };

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WorkflowDetail id={id} />;
}
