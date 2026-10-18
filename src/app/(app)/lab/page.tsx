import type { Metadata } from "next";
import { PlanView } from "@/components/lab/plan-view";

export const metadata: Metadata = { title: "AI Lab" };

export default function LabPage() {
  return <PlanView />;
}
