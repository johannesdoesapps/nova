import type { Metadata } from "next";
import { BenchmarksView } from "@/components/intel/benchmarks-view";

export const metadata: Metadata = { title: "Benchmarks" };

export default function Page() {
  return <BenchmarksView />;
}
