import type { Metadata } from "next";
import { Users } from "lucide-react";
import { ComingSoon } from "@/components/common/coming-soon";

export const metadata: Metadata = { title: "Community" };

export default function CommunityPage() {
  return (
    <ComingSoon
      icon={Users}
      title="NOVARA Community"
      tagline="Share prompts, tool templates and reproducible model comparisons."
      stage="Stage 5"
      planned={[
        "Publish comparisons with their method, date and test conditions.",
        "Share and rate AI Lab templates and prompts.",
        "Moderation, reporting and privacy controls before public submissions open.",
      ]}
      note="Community rankings will never be presented as objective truth."
    />
  );
}
