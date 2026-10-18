import type { Metadata } from "next";
import { WorkflowsList } from "@/components/lab/lists";

export const metadata: Metadata = { title: "Workflows · AI Lab" };

export default function Page() {
  return <WorkflowsList />;
}
