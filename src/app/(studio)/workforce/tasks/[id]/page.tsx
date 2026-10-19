import type { Metadata } from "next";
import { TaskView } from "@/components/workforce/task-view";

export const metadata: Metadata = { title: "Workforce task" };

export default async function WorkforceTaskPage({ params }: PageProps<"/workforce/tasks/[id]">) {
  const { id } = await params;
  return <TaskView id={id} />;
}
