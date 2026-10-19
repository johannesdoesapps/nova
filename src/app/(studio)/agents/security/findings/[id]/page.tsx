import type { Metadata } from "next";
import { FindingView } from "@/components/security/finding-view";

export const metadata: Metadata = { title: "Security finding" };

export default async function FindingPage({ params }: PageProps<"/agents/security/findings/[id]">) {
  const { id } = await params;
  return <FindingView id={id} />;
}
