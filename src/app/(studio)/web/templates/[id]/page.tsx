import { TemplateRunner } from "@/components/workspaces/tool-runner";
export default async function Page({ params }: PageProps<"/web/templates/[id]">) {
  const { id } = await params;
  return <TemplateRunner ws="web" templateId={id} />;
}
