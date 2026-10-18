"use client";
import { useEffect } from "react";
import { Button, Notice } from "@/components/ui/primitives";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="mx-auto max-w-xl px-4 pt-16">
      <Notice tone="danger" title="Something went wrong">
        This page failed to load. {error.digest ? `Reference: ${error.digest}` : "Please try again."}
      </Notice>
      <Button className="mt-4" variant="secondary" onClick={reset}>Try again</Button>
    </div>
  );
}
