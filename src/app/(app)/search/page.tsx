import { Suspense } from "react";
import type { Metadata } from "next";
import { SearchView } from "@/components/search/search-view";
import { Spinner } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "AI Search" };

export default function SearchPage() {
  return (
    <Suspense fallback={<div className="grid min-h-[50vh] place-items-center"><Spinner /></div>}>
      <SearchView />
    </Suspense>
  );
}
