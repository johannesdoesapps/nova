import type { Metadata } from "next";
import { PairHome } from "@/components/code/pair-home";

export const metadata: Metadata = { title: "Pair Coding", description: "Two AI models on one coding task: an Architect writes the code, a Reviewer checks it with evidence." };

export default function PairPage() {
  return <PairHome />;
}
