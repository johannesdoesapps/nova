import type { Metadata } from "next";
import { Composer } from "@/components/lab/composer";

export const metadata: Metadata = { title: "Workflow · AI Lab" };

export default async function WorkflowPage({ params }: PageProps<"/lab/workflows/[id]">) {
  const { id } = await params;
  return <Composer id={id} />;
}
