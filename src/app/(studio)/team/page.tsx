import type { Metadata } from "next";
import { TeamPage } from "@/components/studio/team-page";

export const metadata: Metadata = { title: "Team", description: "One subscription for your team: seats, members and billing." };

export default function Team() {
  return <TeamPage />;
}
