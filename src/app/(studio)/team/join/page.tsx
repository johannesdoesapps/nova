import type { Metadata } from "next";
import { TeamJoin } from "@/components/studio/team-page";

export const metadata: Metadata = { title: "Join a team", robots: { index: false, follow: false } };

export default function Join() {
  return <TeamJoin />;
}
