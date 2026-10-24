import type { Metadata } from "next";
import { ResearchDetail } from "@/components/research/deep-research";

export const metadata: Metadata = { title: "Deep Research" };

export default async function ResearchDetailPage({ params }: PageProps<"/research/[id]">) {
  return <ResearchDetail id={(await params).id} />;
}
