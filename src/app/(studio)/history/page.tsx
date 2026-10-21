import type { Metadata } from "next";
import { HistoryPage } from "@/components/studio/history-page";

export const metadata: Metadata = { title: "Conversations", description: "All your Orbis conversations." };

export default function History() {
  return <HistoryPage />;
}
