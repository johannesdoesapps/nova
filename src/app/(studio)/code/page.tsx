import type { Metadata } from "next";
import { CodeProjectsView } from "@/components/code/projects-view";

export const metadata: Metadata = { title: "Code", description: "Write, run and preview code projects with an AI editor." };

export default function CodePage() {
  return <CodeProjectsView />;
}
