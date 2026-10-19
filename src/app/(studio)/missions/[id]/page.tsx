import type { Metadata } from "next";
import { MissionView } from "@/components/missions/mission-view";

export const metadata: Metadata = { title: "Mission" };

export default async function MissionPage({ params }: PageProps<"/missions/[id]">) {
  const { id } = await params;
  return <MissionView id={id} />;
}
