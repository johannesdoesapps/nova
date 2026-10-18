import type { Metadata } from "next";
import { Suspense } from "react";
import { IntegrationsView } from "@/components/integrations/integrations-view";

export const metadata: Metadata = { title: "Integrations" };

export default function Page() {
  return (
    <Suspense>
      <IntegrationsView />
    </Suspense>
  );
}
