import type { Metadata } from "next";
import { WorkspaceScreen } from "@/components/workspaces/workspace-ui";
export const metadata: Metadata = { title: "Website Builder — Search" };
export default async function Page({ searchParams }: PageProps<"/web/search">) {
  const q = (await searchParams).q;
  return <WorkspaceScreen ws="web" view="search" initialQuery={typeof q === "string" ? q : ""} />;
}
