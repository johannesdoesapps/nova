import type { Metadata } from "next";
import { ProjectsHub } from "@/components/studio/projects-hub";

export const metadata: Metadata = { title: "Projects", description: "Your code projects and missions in one place." };

export default function ProjectsPage() {
  return <ProjectsHub />;
}
