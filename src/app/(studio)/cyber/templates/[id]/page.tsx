import { TemplateRunner } from "@/components/workspaces/tool-runner";
export default async function Page({ params }: PageProps<"/cyber/templates/[id]">) {
  const { id } = await params;
  return <TemplateRunner ws="cyber" templateId={id} />;
}
