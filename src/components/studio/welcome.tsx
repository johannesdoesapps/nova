"use client";
import { useSyncExternalStore, type ReactNode } from "react";
import { CodeXml, Scale, ShieldQuestionMark, Telescope } from "lucide-react";
import type { ChatMode } from "@/lib/ai/modes";
import { NovaMark } from "./ui";

const SUGGESTIONS: { icon: ReactNode; title: string; prompt: string; mode: ChatMode }[] = [
  {
    icon: <Telescope />,
    title: "Explain a concept",
    prompt: "Explain retrieval-augmented generation and when it actually helps.",
    mode: "research",
  },
  {
    icon: <Scale />,
    title: "Compare options",
    prompt: "Compare a modular monolith with microservices for a five-person team.",
    mode: "analyst",
  },
  {
    icon: <ShieldQuestionMark />,
    title: "Stress-test an idea",
    prompt: "Challenge my plan to launch an AI study tool for university students.",
    mode: "critic",
  },
  {
    icon: <CodeXml />,
    title: "Write code",
    prompt: "Write a TypeScript debounce function with tests.",
    mode: "coding",
  },
];

const noSubscribe = () => () => {};

export function Welcome({
  name,
  composer,
  onPick,
  notice,
}: {
  name: string | null;
  composer: ReactNode;
  onPick: (prompt: string, mode: ChatMode) => void;
  notice?: ReactNode;
}) {
  // The hour is only known in the browser; render nothing on the server.
  const hour = useSyncExternalStore(noSubscribe, () => new Date().getHours(), () => null);
  const part = hour === null ? null : hour < 5 || hour >= 18 ? "Good evening" : hour < 12 ? "Good morning" : "Good afternoon";
  const greeting = part && (name ? `${part}, ${name}` : part);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[728px] flex-col items-center justify-center px-4 pb-16 pt-10 sm:px-6">
      <NovaMark className="s-in h-10 w-10 text-s-ink" />
      <p className="s-in mt-6 h-5 text-[14px] text-s-ink-3 [animation-delay:40ms]">{greeting}</p>
      <h1 className="s-in mt-2 text-balance text-center font-serif text-[clamp(34px,6vw,50px)] leading-[1.08] tracking-[-0.01em] [animation-delay:80ms]">
        What can I help you explore?
      </h1>
      <p className="s-in mt-3 max-w-md text-balance text-center text-[15.5px] leading-relaxed text-s-ink-2 [animation-delay:120ms]">
        Research a topic, weigh options, challenge an idea or write code. NOVA tells you when it isn’t sure.
      </p>

      <div className="s-in mt-9 w-full [animation-delay:160ms]">{composer}</div>

      <ul className="mt-5 grid w-full gap-2 sm:grid-cols-2" aria-label="Suggested prompts">
        {SUGGESTIONS.map((s, i) => (
          <li key={s.title} className="s-in" style={{ animationDelay: `${200 + i * 40}ms` }}>
            <button
              type="button"
              onClick={() => onPick(s.prompt, s.mode)}
              className="group flex h-full w-full items-start gap-3 rounded-2xl border border-s-line p-3.5 text-left transition duration-200 hover:border-s-line-strong hover:bg-s-glass active:scale-[0.99]"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-s-line text-s-ink-2 transition group-hover:text-s-accent [&_svg]:h-4 [&_svg]:w-4">
                {s.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium">{s.title}</span>
                <span className="mt-0.5 block text-[13px] leading-snug text-s-ink-3 group-hover:text-s-ink-2">{s.prompt}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>

      {notice && <div className="s-in mt-7 text-center text-[12.5px] text-s-ink-3 [animation-delay:380ms]">{notice}</div>}
    </div>
  );
}
