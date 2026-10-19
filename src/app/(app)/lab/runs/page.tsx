import type { Metadata } from "next";
import { RunsList } from "@/components/lab/run-view";

export const metadata: Metadata = { title: "Runs · AI Lab" };

export default async function Page({ searchParams }: PageProps<"/lab/runs">) {
  // ?workflow=<id> (linked from the workflow editor) shows only that workflow's runs.
  const w = (await searchParams).workflow;
  const workflowId = typeof w === "string" && /^[\w-]{1,100}$/.test(w) ? w : undefined;
  return <RunsList workflowId={workflowId} />;
}
