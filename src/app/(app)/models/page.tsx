import type { Metadata } from "next";
import { RouterView } from "@/components/models/router-view";
import { getModels } from "@/lib/ai";

export const metadata: Metadata = { title: "Model Router" };

export default async function ModelsPage() {
  return <RouterView models={await getModels()} />;
}
