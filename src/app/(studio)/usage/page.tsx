import type { Metadata } from "next";
import { UsagePage } from "@/components/studio/usage-page";

export const metadata: Metadata = { title: "Usage", description: "Your allowance, when it resets, and what you've used." };

export default function Usage() {
  return <UsagePage />;
}
