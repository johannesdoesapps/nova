import { notFound, redirect } from "next/navigation";
import { ProjectDetail } from "@/components/projects/project-detail";
import { getProject } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { loadShellData } from "@/lib/session-data";
import { uuid } from "@/lib/validation";

export default async function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  const { id } = await params;
  if (!uuid.safeParse(id).success) notFound();
  const { auth } = await loadShellData();
  if (auth.mode !== "authenticated") redirect(`/login?next=/projects/${id}`);
  let data: Awaited<ReturnType<typeof getProject>>;
  try {
    data = await getProject(auth.supabase, auth.user.id, id);
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") notFound();
    throw err;
  }
  return <ProjectDetail initial={data as never} />;
}
