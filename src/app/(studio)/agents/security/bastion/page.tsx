import type { Metadata } from "next";
import { BastionWorkspace } from "@/components/security/bastion-workspace";

export const metadata: Metadata = {
  title: "Bastion",
  description: "The protection layer every Orbis agent goes through: enforced policy, where it applies, its decisions and the emergency controls.",
  robots: { index: false },
};

export default function BastionPage() {
  return <BastionWorkspace />;
}
