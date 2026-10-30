import { AgentWorkspace } from "@/components/agents/agent-chat";
export default async function Page({ params }: PageProps<"/cyber/agents/[id]">) {
  const { id } = await params;
  return <AgentWorkspace id={id} backTo="/cyber/agents" backLabel="Cybersecurity" />;
}
