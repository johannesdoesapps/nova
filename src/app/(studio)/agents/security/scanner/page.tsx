import type { Metadata } from "next";
import { Suspense } from "react";
import { SiteScanner } from "@/components/security/site-scanner";

export const metadata: Metadata = {
  title: "Website scanner",
  description: "SSL/TLS, certificate, security header, cookie, content and DNS checks for a website you own, with evidence and fixes.",
  robots: { index: false },
};

export default function WebsiteScannerPage() {
  return (
    <Suspense>
      <SiteScanner />
    </Suspense>
  );
}
