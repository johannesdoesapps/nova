import { Instrument_Serif } from "next/font/google";
import { AppProvider } from "@/components/layout/app-context";
import { loadShellData } from "@/lib/session-data";
import "@/components/studio/studio.css";

export const dynamic = "force-dynamic";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument-serif", display: "swap" });

/** Full-screen chat workspace: shares app data, but not the dashboard shell. */
export default async function StudioLayout({ children }: LayoutProps<"/">) {
  const data = await loadShellData();
  return (
    <AppProvider user={data.user} integrations={data.integrations} initialRecents={data.recents} supabasePublic={data.supabasePublic}>
      <div className={serif.variable}>{children}</div>
    </AppProvider>
  );
}
