import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { IntegrationsView } from "@/components/integrations/integrations-view";

export const metadata: Metadata = { title: "Integrations" };

/**
 * Workspace sync integrations run in the Orbis engine. Without the engine
 * this page has nothing to show, so it opens Connectors (connected apps for
 * chat and search) instead.
 */
export default function Page() {
  if (!process.env.ORBIS_ENGINE_URL?.trim()) redirect("/connectors");
  return (
    <Suspense>
      <IntegrationsView />
    </Suspense>
  );
}
