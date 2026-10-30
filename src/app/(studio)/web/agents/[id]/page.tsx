import { AgentWorkspace } from "@/components/agents/agent-chat";
export default async function Page({ params }: PageProps<"/web/agents/[id]">) {
  const { id } = await params;
  return <AgentWorkspace id={id} backTo="/web/agents" backLabel="Website Builder" />;
}
