import type { Metadata } from "next";
import { HistoryView } from "@/components/intel/history-view";

export const metadata: Metadata = { title: "Evaluation History" };

export default function Page() {
  return <HistoryView />;
}
