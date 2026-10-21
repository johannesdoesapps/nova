"use client";
import Link from "next/link";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowRight, Bot, CodeXml, FileText, ListChecks, Telescope } from "lucide-react";
import { useLocalStorage } from "@/hooks/use-local-storage";
import type { ChatMode } from "@/lib/ai/modes";
import { OrbisMark } from "./ui";

type Goal = "ask" | "documents" | "build" | "agent" | "plan";

/** First steps by what the user wants to do: prompts to send or start from, and the workspace that fits. */
const GOALS: {
  id: Goal;
  label: string;
  icon: ReactNode;
  intro: string;
  link?: { href: string; label: string; text: string };
  prompts: { title: string; prompt: string; mode: ChatMode; draft?: boolean }[];
}[] = [
  {
    id: "ask",
    label: "Ask or research",
    icon: <Telescope />,
    intro: "Ask anything. Auto picks a model and says why under the reply.",
    prompts: [
      { title: "Explain a concept", prompt: "Explain retrieval-augmented generation and give me a practical example.", mode: "research" },
      { title: "Compare options", prompt: "Compare a modular monolith with microservices for a five-person team.", mode: "analyst" },
      { title: "Stress-test an idea", prompt: "Challenge my plan to launch an AI study tool for university students.", mode: "critic" },
    ],
  },
  {
    id: "documents",
    label: "Write or analyse documents",
    icon: <FileText />,
    intro: "Attach a document with the paperclip (or drag it in), then start from one of these.",
    prompts: [
      { title: "Summarise a document", prompt: "Analyse this document and summarise its key findings.", mode: "analyst", draft: true },
      { title: "Draft something", prompt: "Draft a clear, friendly email announcing a product update to our customers.", mode: "research" },
      { title: "Improve writing", prompt: "Edit this for clarity and concision, and explain your main changes:\n\n", mode: "critic", draft: true },
    ],
  },
  {
    id: "build",
    label: "Build or debug software",
    icon: <CodeXml />,
    intro: "Ask here for code you can run in the chat, or open Code for a project the agent can edit and test.",
    link: { href: "/code", label: "Open Code", text: "Create or import a project, and let the agent plan, edit and run its tests." },
    prompts: [
      { title: "Write code", prompt: "Write a TypeScript debounce function with tests.", mode: "coding" },
      { title: "Find bugs", prompt: "Inspect this code and identify potential bugs:\n\n", mode: "coding", draft: true },
    ],
  },
  {
    id: "agent",
    label: "Create an agent",
    icon: <Bot />,
    intro: "Agents keep their own instructions, default model and history.",
    link: { href: "/agents?create=1", label: "Create an agent", text: "Describe how it should work, or start from a built-in agent." },
    prompts: [{ title: "Help me write instructions", prompt: "Help me write instructions for an AI agent that reviews my blog drafts for clarity and tone.", mode: "research" }],
  },
  {
    id: "plan",
    label: "Plan a project",
    icon: <ListChecks />,
    intro: "Turn a goal into milestones and tasks you can work through.",
    link: { href: "/missions", label: "Open Mission Control", text: "Describe a goal; Orbis proposes a plan you edit, and drafts the tasks it can." },
    prompts: [{ title: "Quick plan in chat", prompt: "Turn this goal into an actionable plan: launch a weekly newsletter within six weeks.", mode: "analyst" }],
  },
];

const noSubscribe = () => () => {};

export function Welcome({
  name,
  composer,
  onPick,
  onDraft,
  notice,
}: {
  name: string | null;
  composer: ReactNode;
  onPick: (prompt: string, mode: ChatMode) => void;
  /** Put a prompt in the composer to finish (e.g. after attaching a file). */
  onDraft?: (prompt: string, mode: ChatMode) => void;
  notice?: ReactNode;
}) {
  // Ideas for a goal appear only once its chip is chosen (and hide when it's chosen again).
  const [goal, setGoal] = useState<Goal | null>(null);
  // New here: a one-line introduction until the first message is sent.
  const [welcomed, setWelcomed] = useLocalStorage("orbis:welcomed");
  const g = GOALS.find((x) => x.id === goal);
  // The hour is only known in the browser; render nothing on the server.
  const hour = useSyncExternalStore(noSubscribe, () => new Date().getHours(), () => null);
  const part = hour === null ? null : hour < 5 || hour >= 18 ? "Good evening" : hour < 12 ? "Good morning" : "Good afternoon";
  const greeting = part && (name ? `${part}, ${name}` : part);

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[728px] flex-col items-center justify-center px-4 pb-16 pt-10 sm:px-6">
      <OrbisMark className="s-in h-10 w-10 text-s-ink" />
      <p className="s-in mt-6 h-5 text-[14px] text-s-ink-3 [animation-delay:40ms]">{greeting}</p>
      <h1 className="s-in mt-2 text-balance text-center font-serif text-[clamp(34px,6vw,50px)] leading-[1.08] tracking-[-0.01em] [animation-delay:80ms]">
        What can I help you explore?
      </h1>
      <div className="s-in mt-8 w-full [animation-delay:120ms]">{composer}</div>

      <div
        role="group"
        aria-label={welcomed ? "Ideas" : "New here? Pick what you want to do first"}
        className="s-in mt-5 flex w-full gap-1.5 overflow-x-auto pb-1 [animation-delay:160ms] sm:flex-wrap sm:justify-center"
      >
        {GOALS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={goal === x.id}
            aria-controls="goal-panel"
            onClick={() => setGoal(goal === x.id ? null : x.id)}
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition [&_svg]:h-3.5 [&_svg]:w-3.5 ${goal === x.id ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-3 hover:text-s-ink"}`}
          >
            {x.icon}
            {x.label}
          </button>
        ))}
      </div>

      {g && (
      <div id="goal-panel" className="s-in mt-3 w-full">
        <p className="mb-2.5 text-center text-[13px] text-s-ink-3">{g.intro}</p>
        <ul className="grid w-full gap-2 sm:grid-cols-2">
          {g.link && (
            <li>
              <Link href={g.link.href} className="group flex h-full w-full items-start gap-3 rounded-2xl border border-s-line-strong bg-s-glass p-3.5 text-left transition duration-200 hover:border-s-accent/60">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-s-accent text-s-accent-ink [&_svg]:h-4 [&_svg]:w-4">{g.icon}</span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1 text-[13.5px] font-medium">
                    {g.link.label} <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-s-ink-3 group-hover:text-s-ink-2">{g.link.text}</span>
                </span>
              </Link>
            </li>
          )}
          {g.prompts.map((p) => (
            <li key={p.title}>
              <button
                type="button"
                onClick={() => {
                  if (!welcomed) setWelcomed("1");
                  if (p.draft && onDraft) onDraft(p.prompt, p.mode);
                  else onPick(p.prompt, p.mode);
                }}
                className="group flex h-full w-full items-start gap-3 rounded-2xl border border-s-line p-3.5 text-left transition duration-200 hover:border-s-line-strong hover:bg-s-glass active:scale-[0.99]"
              >
                <span className="min-w-0">
                  <span className="block text-[13.5px] font-medium">
                    {p.title}
                    {p.draft && <span className="ml-1.5 text-[11.5px] font-normal text-s-ink-3">· fills in the box</span>}
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-s-ink-3 group-hover:text-s-ink-2">{p.prompt.trim()}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      )}

      {notice && <div className="s-in mt-7 text-center text-[12.5px] text-s-ink-3 [animation-delay:380ms]">{notice}</div>}
    </div>
  );
}
