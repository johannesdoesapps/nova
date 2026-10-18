import type { Metadata } from "next";
import { RunsList } from "@/components/lab/run-view";

export const metadata: Metadata = { title: "Runs · AI Lab" };

export default function Page() {
  return <RunsList />;
}
