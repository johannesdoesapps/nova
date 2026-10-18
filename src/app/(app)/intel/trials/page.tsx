import type { Metadata } from "next";
import { TrialsView } from "@/components/intel/trials-view";

export const metadata: Metadata = { title: "Blind Trials" };

export default function Page() {
  return <TrialsView />;
}
