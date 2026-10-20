import type { Metadata } from "next";
import { Suspense } from "react";
import { ConnectorsView } from "@/components/connectors/connectors-view";

export const metadata: Metadata = { title: "Connectors", description: "Connect your apps so Orbis can search and use them." };

export default function ConnectorsPage() {
  return (
    <Suspense>
      <ConnectorsView />
    </Suspense>
  );
}
