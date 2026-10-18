import type { Metadata } from "next";
import { WorkspaceDetail } from "@/components/workspaces/workspace-detail";

export const metadata: Metadata = { title: "Workspace" };

export default async function Page({ params }: PageProps<"/workspaces/[id]">) {
  const { id } = await params;
  return <WorkspaceDetail id={id} />;
}
