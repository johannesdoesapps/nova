import { LegalDocument } from "@/components/marketing/legal-document";
import { VisitCountChoice } from "@/components/marketing/visit-count-choice";
import { COOKIES } from "@/content/legal";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Cookie Policy",
  description: "Every cookie and browser-storage item Orbis uses, why, and for how long; how visits are counted without cookies; and how to turn that off.",
  path: "/cookies",
});

export default function CookiesPage() {
  return (
    <LegalDocument
      title="Cookie Policy"
      intro="The cookies and browser storage Orbis uses, what each one is for and how long it lasts, and the choices you have."
      sections={COOKIES}
      aside={<VisitCountChoice />}
    />
  );
}
