import type { Metadata } from "next";
import { RadarView } from "@/components/radar/radar-view";

export const metadata: Metadata = { title: "Signal Radar" };

export default function RadarPage() {
  return <RadarView />;
}
