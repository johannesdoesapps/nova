import type { Metadata } from "next";
import { WorkspaceScreen } from "@/components/workspaces/workspace-ui";
export const metadata: Metadata = { title: "Website Builder — Templates" };
export default function Page() {
  return <WorkspaceScreen ws="web" view="templates" />;
}
