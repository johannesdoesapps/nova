import type { Metadata } from "next";
import { RunView } from "@/components/security/run-view";

export const metadata: Metadata = { title: "Security results" };

export default async function RunPage({ params }: PageProps<"/agents/security/runs/[id]">) {
  const { id } = await params;
  return <RunView id={id} />;
}
