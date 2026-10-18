import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupNotice } from "@/components/common/setup-notice";
import { ProjectsView } from "@/components/projects/projects-view";
import { PageHeader } from "@/components/ui/primitives";
import { listProjects } from "@/lib/db";
import { isSupabaseConfigured } from "@/lib/env";
import { loadShellData } from "@/lib/session-data";

export const metadata: Metadata = { title: "Research Projects" };

export default async function ProjectsPage() {
  if (!isSupabaseConfigured()) {
    return (
      <div className="mx-auto max-w-3xl px-4 pt-8 sm:px-6">
        <PageHeader title="Research Projects" description="Organise conversations, searches, comparisons and notes." />
        <SetupNotice feature="Research Projects" demo={false} envVars={["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]} />
      </div>
    );
  }
  const { auth } = await loadShellData();
  if (auth.mode !== "authenticated") redirect("/login?next=/projects");
  const projects = await listProjects(auth.supabase, auth.user.id, 100);
  return <ProjectsView initial={projects} />;
}
