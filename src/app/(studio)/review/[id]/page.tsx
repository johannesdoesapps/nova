import type { Metadata } from "next";
import { ReviewDetail } from "@/components/review/review-view";

export const metadata: Metadata = { title: "Code Review" };

export default async function ReviewDetailPage({ params }: PageProps<"/review/[id]">) {
  return <ReviewDetail id={(await params).id} />;
}
