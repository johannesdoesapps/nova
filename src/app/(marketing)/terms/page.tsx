import { LegalDocument } from "@/components/marketing/legal-document";
import { TERMS } from "@/content/legal";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Terms of Service",
  description: "The terms for using Orbis: who can use it, AI output, your content, acceptable use, plans and payment, and our responsibilities to you.",
  path: "/terms",
});

export default function TermsPage() {
  return <LegalDocument title="Terms of Service" intro="The agreement between you and Orbis when you use tryorbis.app. Please read it together with our Privacy Policy." sections={TERMS} />;
}
