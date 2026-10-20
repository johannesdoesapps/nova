import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CodeWorkspace } from "@/components/code/workspace";

export const metadata: Metadata = { title: "Code" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CodeProjectPage({ params }: PageProps<"/code/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <CodeWorkspace id={id} />;
}
