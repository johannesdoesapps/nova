import type { Metadata } from "next";
import { TemplatesGallery } from "@/components/lab/lists";

export const metadata: Metadata = { title: "Templates · AI Lab" };

export default function Page() {
  return <TemplatesGallery />;
}
