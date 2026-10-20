import { LegalDocument } from "@/components/marketing/legal-document";
import { PRIVACY } from "@/content/legal";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Privacy Policy",
  description: "What personal data Orbis collects, why, who receives it (including AI providers), how long it's kept, and your rights under UK data protection law.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return <LegalDocument title="Privacy Policy" intro="How Orbis collects, uses and protects your personal data, and the choices and rights you have." sections={PRIVACY} />;
}
