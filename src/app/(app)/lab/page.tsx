import type { Metadata } from "next";
import { FlaskConical } from "lucide-react";
import { ComingSoon } from "@/components/common/coming-soon";

export const metadata: Metadata = { title: "AI Lab" };

export default function LabPage() {
  return (
    <ComingSoon
      icon={FlaskConical}
      title="AI Lab"
      tagline="Reusable AI tools built from templates."
      stage="Stage 5"
      planned={[
        "Templates: document summariser, text rewriter, CSV analyser, meeting notes, FAQ generator, prompt tester.",
        "Pick a template, enter inputs, choose a model, run and save the configuration.",
        "Custom workflows later — no arbitrary code execution without a secure sandbox.",
      ]}
    />
  );
}
