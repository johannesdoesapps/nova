import { Suspense } from "react";
import { Instrument_Serif } from "next/font/google";
import { AppProvider } from "@/components/layout/app-context";
import { StudioFrame } from "@/components/studio/frame";
import { loadShellData } from "@/lib/session-data";
import "@/components/studio/studio.css";

export const dynamic = "force-dynamic";

const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", variable: "--font-instrument-serif", display: "swap" });

/**
 * Full-screen studio (Chat and Agents): shares app data, but not the dashboard
 * shell. The frame — sidebar, dialogs, theme — persists across both pages.
 */
export default async function StudioLayout({ children }: LayoutProps<"/">) {
  const data = await loadShellData();
  return (
    <AppProvider user={data.user} integrations={data.integrations} initialRecents={data.recents} supabasePublic={data.supabasePublic}>
      <div className={serif.variable}>
        <Suspense>
          <StudioFrame>{children}</StudioFrame>
        </Suspense>
      </div>
    </AppProvider>
  );
}
