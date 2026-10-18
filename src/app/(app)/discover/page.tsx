import type { Metadata } from "next";
import { DiscoverView } from "@/components/discover/discover-view";

export const metadata: Metadata = { title: "Model Discovery" };

export default function DiscoverPage() {
  return <DiscoverView />;
}
