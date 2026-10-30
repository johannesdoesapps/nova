import type { Metadata } from "next";
import { WorkspaceScreen } from "@/components/workspaces/workspace-ui";
export const metadata: Metadata = { title: "Cybersecurity — Search" };
export default async function Page({ searchParams }: PageProps<"/cyber/search">) {
  const q = (await searchParams).q;
  return <WorkspaceScreen ws="cyber" view="search" initialQuery={typeof q === "string" ? q : ""} />;
}
