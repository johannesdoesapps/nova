import type { Metadata } from "next";
import { DiscoverPage } from "@/components/studio/discover-page";

export const metadata: Metadata = { title: "Discover", description: "What Orbis can do, with a way to try each one." };

export default function Discover() {
  return <DiscoverPage />;
}
