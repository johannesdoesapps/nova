import type { Metadata } from "next";
import { ShareView } from "@/components/workspaces/share-view";

export const metadata: Metadata = { title: "Shared workspace", robots: { index: false, follow: false } };

export default async function Page({ params }: PageProps<"/share/[token]">) {
  const { token } = await params;
  return <ShareView token={token} />;
}
