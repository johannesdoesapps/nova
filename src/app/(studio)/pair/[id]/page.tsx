import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CodeWorkspace } from "@/components/code/workspace";

export const metadata: Metadata = { title: "Pair Coding" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A project in Pair Coding: the code workspace with two agents (Architect and Reviewer) instead of one. */
export default async function PairProjectPage({ params }: PageProps<"/pair/[id]">) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <CodeWorkspace id={id} pair />;
}
