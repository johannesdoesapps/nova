import type { Metadata } from "next";
import { RunView } from "@/components/lab/run-view";

export const metadata: Metadata = { title: "Run · AI Lab" };

export default async function RunPage({ params }: PageProps<"/lab/runs/[id]">) {
  const { id } = await params;
  return <RunView id={id} />;
}
