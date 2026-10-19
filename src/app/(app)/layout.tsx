import type { Metadata } from "next";
import { PRIVATE_ROBOTS } from "@/lib/seo";
import { AppProvider } from "@/components/layout/app-context";
import { AppShell } from "@/components/layout/app-shell";
import { loadShellData } from "@/lib/session-data";

export const dynamic = "force-dynamic";

// Signed-in app screens: never in search results.
export const metadata: Metadata = { robots: PRIVATE_ROBOTS };

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const data = await loadShellData();
  return (
    <AppProvider user={data.user} integrations={data.integrations} initialRecents={data.recents} supabasePublic={data.supabasePublic}>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
