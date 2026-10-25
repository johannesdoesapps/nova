import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { NativeBridge } from "@/components/common/native-bridge";
import { SiteAnalytics } from "@/components/common/site-analytics";
import { SITE_NAME, siteUrl } from "@/lib/seo";
import "./globals.css";

const DESCRIPTION =
  "Orbis is an AI workspace with Claude and GPT models, specialised and custom AI agents, model comparison, project planning and security agents.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: "Orbis — AI assistant and agent workspace", template: "%s · Orbis" },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  openGraph: { type: "website", siteName: SITE_NAME, locale: "en_US", title: "Orbis — AI assistant and agent workspace", description: DESCRIPTION },
  twitter: { card: "summary_large_image" },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: "#07070b",
  width: "device-width",
  initialScale: 1,
  // Draw under the notch and home indicator so the safe-area spacing (env(safe-area-inset-*)) the shell already
  // uses takes effect on iPhones and in the mobile app; the on-screen keyboard resizes the page so the chat
  // composer stays above it.
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before paint to avoid a flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('orbis:theme');if(t==='system')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-dvh">
        {children}
        <NativeBridge />
        <SiteAnalytics />
      </body>
    </html>
  );
}
