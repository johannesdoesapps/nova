import type { Metadata } from "next";
import { ReviewHome } from "@/components/review/review-home";

export const metadata: Metadata = {
  title: "Code Review",
  description: "Review code, a diff or a pull request for bugs, edge cases, security problems and missing tests, with evidence for every finding.",
};

export default function ReviewPage() {
  return <ReviewHome />;
}
