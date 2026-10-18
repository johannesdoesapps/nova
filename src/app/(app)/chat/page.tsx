import { Suspense } from "react";
import type { Metadata } from "next";
import { ChatView } from "@/components/chat/chat-view";
import { Spinner } from "@/components/ui/primitives";

export const metadata: Metadata = { title: "AI Chat" };

export default function ChatPage() {
  return (
    <Suspense fallback={<div className="grid min-h-[50vh] place-items-center"><Spinner /></div>}>
      <ChatView />
    </Suspense>
  );
}
