import type { Metadata } from "next";
import { ProfileWorkspace } from "@/components/agent-platform/profile-workspace";

export const metadata: Metadata = { title: "QA Testing agent", description: "Write tests, run them in an isolated computer and report what failed." };

export default function QaTesterPage() {
  return <ProfileWorkspace profile="qa_tester" />;
}
