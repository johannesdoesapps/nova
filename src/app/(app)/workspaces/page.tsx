import type { Metadata } from "next";
import { WorkspacesView } from "@/components/workspaces/workspaces-view";

export const metadata: Metadata = { title: "Workspaces" };

export default function Page() {
  return <WorkspacesView />;
}
