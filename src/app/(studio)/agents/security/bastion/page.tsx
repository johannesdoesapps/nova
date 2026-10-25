import type { Metadata } from "next";
import { BastionPage } from "@/components/security/bastion-customer";

export const metadata: Metadata = {
  title: "Bastion",
  description: "Security for your workspace: agents, connected services, applications, findings and policies, on top of the protections Orbis enforces for every agent.",
  robots: { index: false },
};

export default function Page() {
  return <BastionPage />;
}
