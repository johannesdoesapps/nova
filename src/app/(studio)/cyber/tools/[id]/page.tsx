import { ToolRunner } from "@/components/workspaces/tool-runner";
export default async function Page({ params }: PageProps<"/cyber/tools/[id]">) {
  const { id } = await params;
  return <ToolRunner ws="cyber" toolId={id} />;
}
