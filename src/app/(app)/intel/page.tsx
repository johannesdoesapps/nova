import type { Metadata } from "next";
import { FingerprintView } from "@/components/intel/fingerprint-view";

export const metadata: Metadata = { title: "Model Fingerprint" };

export default function Page() {
  return <FingerprintView />;
}
