import type { Metadata } from "next";
import { JarvisView } from "@/components/jarvis/jarvis-view";

export const metadata: Metadata = { title: "Jarvis", description: "A voice-first assistant that plans and carries out tasks, in the browser and on your computer." };

export default function Jarvis() {
  return <JarvisView />;
}
