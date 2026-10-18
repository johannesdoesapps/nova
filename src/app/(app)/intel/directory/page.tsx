import type { Metadata } from "next";
import { DirectoryView } from "@/components/intel/directory-view";

export const metadata: Metadata = { title: "Model Directory" };

export default function Page() {
  return <DirectoryView />;
}
