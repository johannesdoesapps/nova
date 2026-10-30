import type { Metadata } from "next";
import { WorkspaceScreen } from "@/components/workspaces/workspace-ui";
export const metadata: Metadata = { title: "Cybersecurity — Templates" };
export default function Page() {
  return <WorkspaceScreen ws="cyber" view="templates" />;
}
