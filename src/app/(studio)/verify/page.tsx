import type { Metadata } from "next";
import { VerifyPage } from "@/components/studio/verify-page";

export const metadata: Metadata = { title: "Verify", description: "Check the claims in an answer, a document or several responses against sources." };

export default function Verify() {
  return <VerifyPage />;
}
