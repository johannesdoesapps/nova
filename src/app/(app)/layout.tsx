import { AppProvider } from "@/components/layout/app-context";
import { AppShell } from "@/components/layout/app-shell";
import { loadShellData } from "@/lib/session-data";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const data = await loadShellData();
  return (
    <AppProvider user={data.user} integrations={data.integrations} initialRecents={data.recents} supabasePublic={data.supabasePublic}>
      <AppShell>{children}</AppShell>
    </AppProvider>
  );
}
