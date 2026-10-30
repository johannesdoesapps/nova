import { ToolRunner } from "@/components/workspaces/tool-runner";
export default async function Page({ params }: PageProps<"/web/tools/[id]">) {
  const { id } = await params;
  return <ToolRunner ws="web" toolId={id} />;
}
