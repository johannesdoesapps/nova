import type { Metadata } from "next";
import { ToolsPermissions } from "@/components/lab/lists";

export const metadata: Metadata = { title: "Tool permissions · AI Lab" };

export default function Page() {
  return <ToolsPermissions />;
}
