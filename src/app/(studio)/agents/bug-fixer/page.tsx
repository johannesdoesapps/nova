import type { Metadata } from "next";
import { ProfileWorkspace } from "@/components/agent-platform/profile-workspace";

export const metadata: Metadata = { title: "Bug Fixing agent", description: "Reproduce a bug in an isolated computer, fix the root cause and re-run the tests." };

export default function BugFixerPage() {
  return <ProfileWorkspace profile="bug_fixer" />;
}
