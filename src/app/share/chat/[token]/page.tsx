import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Markdown } from "@/components/common/markdown";
import { Logo } from "@/components/layout/logo";
import { getAllModels } from "@/lib/ai";
import { RETIRED_MODELS } from "@/lib/ai/registry";
import { PRIVATE_ROBOTS } from "@/lib/seo";
import { createServerSupabase } from "@/lib/supabase/server";
import "@/components/studio/studio.css";

export const dynamic = "force-dynamic";

interface SharedChat {
  title: string;
  shared_at: string;
  messages: { role: "user" | "assistant"; content: string; model_id: string | null; created_at: string }[];
}

/** The shared chat, or null when the link is wrong or sharing was turned off. */
async function load(token: string): Promise<SharedChat | null> {
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
  try {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.rpc("shared_conversation", { p_token: token });
    return error ? null : ((data as SharedChat | null) ?? null);
  } catch {
    return null;
  }
}

export async function generateMetadata({ params }: PageProps<"/share/chat/[token]">): Promise<Metadata> {
  const chat = await load((await params).token);
  // Shared chats are reachable by link only: never in search results.
  return { title: chat ? `${chat.title} · Shared chat` : "Shared chat", robots: PRIVATE_ROBOTS, referrer: "no-referrer" };
}

export default async function SharedChatPage({ params }: PageProps<"/share/chat/[token]">) {
  const chat = await load((await params).token);
  if (!chat) notFound();
  const models = await getAllModels().catch(() => []);
  const names = new Map([...Object.entries(RETIRED_MODELS).map(([id, r]) => [id, r.displayName] as const), ...models.map((m) => [m.id, m.displayName] as const)]);
  const sharedOn = new Date(chat.shared_at).toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  return (
    <div className="studio min-h-dvh bg-s-bg text-s-ink">
      <header className="sticky top-0 z-10 border-b border-s-line bg-s-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[768px] items-center justify-between gap-3 px-4 sm:px-8">
          <Link href="/" aria-label="Orbis home">
            <Logo />
          </Link>
          <Link href="/login" className="inline-flex h-9 items-center rounded-full bg-s-ink px-4 text-[13.5px] font-medium text-s-bg hover:opacity-90">
            Try Orbis
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[768px] px-4 pb-24 pt-8 sm:px-8">
        <h1 className="text-[24px] font-semibold leading-tight tracking-[-0.01em] sm:text-[28px]">{chat.title}</h1>
        <p className="mt-2 text-[13.5px] text-s-ink-2">Shared chat · {sharedOn} · read-only. It shows the chat as it was when its owner shared it.</p>

        <div className="mt-10 flex flex-col gap-10">
          {chat.messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[22px] rounded-br-lg bg-s-user px-4 py-2.5 text-[15.5px] leading-relaxed sm:max-w-[78%]">{m.content}</div>
              </div>
            ) : (
              <div key={i}>
                <Markdown text={m.content} />
                {m.model_id && <p className="mt-2 text-[12px] text-s-ink-3">{names.get(m.model_id) ?? m.model_id}</p>}
              </div>
            ),
          )}
          {chat.messages.length === 0 && <p className="text-[14px] text-s-ink-2">This chat has no messages.</p>}
        </div>

        <p className="mt-16 border-t border-s-line pt-6 text-[12.5px] text-s-ink-3">
          Orbis can make mistakes. Check important information. The person who shared this chat can stop sharing it at any time.
        </p>
      </main>
    </div>
  );
}
