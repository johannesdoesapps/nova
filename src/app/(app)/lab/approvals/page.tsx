import type { Metadata } from "next";
import { ApprovalsInbox } from "@/components/lab/run-view";

export const metadata: Metadata = { title: "Approvals · AI Lab" };

export default function Page() {
  return <ApprovalsInbox />;
}
