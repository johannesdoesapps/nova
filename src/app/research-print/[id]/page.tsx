import type { Metadata } from "next";
import { ResearchPrint } from "@/components/research/research-print";

export const metadata: Metadata = { title: "Research report", robots: { index: false, follow: false } };

export default async function ResearchPrintPage({ params }: PageProps<"/research-print/[id]">) {
  return <ResearchPrint id={(await params).id} />;
}
