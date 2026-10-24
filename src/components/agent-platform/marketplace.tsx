"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, BarChart3, Bug, CircleAlert, Code2, FlaskConical, Globe, Info, ScanSearch, ShieldCheck, Telescope, type LucideIcon } from "lucide-react";
import { Dialog } from "@/components/studio/ui";
import { plansLabel, type Availability } from "@/lib/agent-platform/availability";
import { AGENT_CATEGORIES, PERMISSION_LABEL, type AgentDef } from "@/lib/agent-platform/registry";
import { cn } from "@/lib/utils";

export const AGENT_ICON: Record<AgentDef["icon"], LucideIcon> = {
  code: Code2,
  scan: ScanSearch,
  bug: Bug,
  flask: FlaskConical,
  shield: ShieldCheck,
  telescope: Telescope,
  globe: Globe,
  chart: BarChart3,
};

const ICON_TONE: Record<AgentDef["category"], string> = {
  Software: "from-violet-500/25 text-violet-600 dark:text-violet-300",
  Security: "from-amber-500/25 text-amber-700 dark:text-amber-300",
  Research: "from-sky-500/25 text-sky-700 dark:text-sky-300",
  Data: "from-emerald-500/25 text-emerald-700 dark:text-emerald-300",
};

interface Listing {
  agent: AgentDef;
  availability: Availability;
}

type Load = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; agents: Listing[] };

const STATE_LABEL: Record<Availability["state"], string> = { available: "Ready", setup: "Not set up here", upgrade: "Upgrade", sign_in: "Sign in" };
const STATE_DOT: Record<Availability["state"], string> = { available: "bg-[#3f9f62]", setup: "bg-s-ink-3", upgrade: "bg-[#c98a1c]", sign_in: "bg-s-ink-3" };

export function AgentIconTile({ agent, size = "md" }: { agent: Pick<AgentDef, "icon" | "category">; size?: "md" | "lg" }) {
  const Icon = AGENT_ICON[agent.icon];
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center border border-s-line bg-s-bg bg-gradient-to-br to-transparent",
        size === "lg" ? "h-12 w-12 rounded-[15px]" : "h-11 w-11 rounded-[14px]",
        ICON_TONE[agent.category],
      )}
    >
      <Icon className={size === "lg" ? "h-[22px] w-[22px]" : "h-5 w-5"} aria-hidden />
    </span>
  );
}

/** The task agents (from the registry), with whether each can run here for this user, from the server. */
export function TaskAgents({ query }: { query: string }) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [category, setCategory] = useState<string>("all");
  const [details, setDetails] = useState<Listing | null>(null);

  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    fetch("/api/agent-platform", { cache: "no-store" })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as { agents?: Listing[]; error?: { message?: string } } | null;
        if (!r.ok || !j?.agents) throw new Error(j?.error?.message ?? "Agents couldn't be loaded.");
        if (alive) setLoad({ status: "ready", agents: j.agents });
      })
      .catch((e: Error) => alive && setLoad({ status: "error", message: e.message }));
    return () => {
      alive = false;
    };
  }, [attempt]);
  const fetchAgents = () => {
    setLoad({ status: "loading" });
    setAttempt((n) => n + 1);
  };

  const visible = useMemo(() => {
    if (load.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    return load.agents.filter(
      ({ agent: a }) => (category === "all" || a.category === category) && (!q || `${a.name} ${a.tagline} ${a.description} ${a.category} ${a.capabilities.join(" ")}`.toLowerCase().includes(q)),
    );
  }, [load, category, query]);

  return (
    <section aria-labelledby="task-agents" className="s-in mt-8 [animation-delay:40ms]">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="task-agents" className="text-[18px] font-semibold tracking-[-0.01em]">
            Task agents
          </h2>
          <p className="mt-0.5 text-[13.5px] text-s-ink-2">Give them a task; they do the work and report only what actually ran.</p>
        </div>
        <div role="tablist" aria-label="Agent categories" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:px-0 sm:pb-0">
          {["all", ...AGENT_CATEGORIES].map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={category === c}
              onClick={() => setCategory(c)}
              className={cn(
                "h-8 shrink-0 rounded-full border px-3 text-[12.5px] transition duration-200",
                category === c ? "border-transparent bg-s-ink text-s-bg" : "border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink",
              )}
            >
              {c === "all" ? "All" : c}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {load.status === "loading" ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="glass h-[176px] rounded-[22px] p-5">
                <div className="flex gap-3.5">
                  <div className="s-skeleton h-11 w-11 rounded-[14px]" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="s-skeleton h-4 w-2/3" />
                    <div className="s-skeleton h-3 w-1/3" />
                  </div>
                </div>
                <div className="s-skeleton mt-5 h-3 w-full" />
              </div>
            ))}
          </div>
        ) : load.status === "error" ? (
          <div role="alert" className="glass flex flex-wrap items-center gap-3 rounded-[18px] px-4 py-3 text-[13.5px]">
            <CircleAlert className="h-4 w-4 text-s-danger" aria-hidden />
            <span className="flex-1">{load.message}</span>
            <button type="button" onClick={fetchAgents} className="rounded-lg border border-s-line-strong px-3 py-1.5 text-[13px] font-medium hover:bg-s-hover">
              Try again
            </button>
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-[18px] border border-dashed border-s-line-strong px-4 py-6 text-center text-[13.5px] text-s-ink-2">No task agents match.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((l, i) => (
              <TaskAgentCard key={l.agent.id} listing={l} index={i} onDetails={() => setDetails(l)} />
            ))}
          </div>
        )}
      </div>

      <AgentDetails listing={details} onClose={() => setDetails(null)} />
    </section>
  );
}

function TaskAgentCard({ listing, index, onDetails }: { listing: Listing; index: number; onDetails: () => void }) {
  const { agent: a, availability: av } = listing;
  const ready = av.state === "available";
  return (
    <article
      className="glass group relative flex flex-col rounded-[22px] p-5 transition duration-300 hover:-translate-y-0.5 hover:border-s-line-strong hover:bg-s-glass-strong hover:shadow-[var(--s-shadow)]"
      style={{ animation: `s-in .34s cubic-bezier(.2,.7,.2,1) ${Math.min(index, 8) * 35}ms both` }}
    >
      <div className="flex items-start gap-3.5">
        <AgentIconTile agent={a} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h3 className="truncate text-[15.5px] font-semibold tracking-[-0.01em]">
            <Link
              href={a.href}
              className="outline-none after:absolute after:inset-0 after:rounded-[22px] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-[var(--s-ring)]"
            >
              {a.name}
            </Link>
          </h3>
          <p className="mt-1 flex min-w-0 items-center gap-x-2 whitespace-nowrap text-[12.5px] text-s-ink-3">
            <span>{a.category}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex min-w-0 items-center gap-1.5" title={"message" in av ? av.message : undefined}>
              <span className={cn("h-1.5 w-1.5 rounded-full", STATE_DOT[av.state])} aria-hidden />
              {av.state === "upgrade" ? plansLabel(av.plans) : STATE_LABEL[av.state]}
            </span>
          </p>
        </div>
      </div>
      <p className="mt-3.5 line-clamp-2 min-h-[2.9em] text-[13.5px] leading-relaxed text-s-ink-2">{a.tagline}</p>
      {!ready && "message" in av && <p className="mt-2 text-[12.5px] text-s-ink-3">{av.message}</p>}
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <button
          type="button"
          onClick={onDetails}
          className="relative z-10 inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-[13px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink"
        >
          <Info className="h-3.5 w-3.5" aria-hidden /> Details<span className="sr-only"> about {a.name}</span>
        </button>
        <span
          className="relative inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium transition duration-200 group-hover:border-transparent group-hover:bg-s-accent group-hover:text-s-accent-ink"
          aria-hidden
        >
          Open <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </article>
  );
}

function AgentDetails({ listing, onClose }: { listing: Listing | null; onClose: () => void }) {
  const a = listing?.agent;
  const av = listing?.availability;
  return (
    <Dialog open={!!listing} onClose={onClose} title={a?.name ?? "Agent"} description={a?.description} width={620}>
      {a && av && (
        <div className="space-y-5 text-[13.5px]">
          {av.state !== "available" && "message" in av && (
            <p className="rounded-xl border border-s-line bg-s-hover/60 px-3 py-2 text-s-ink-2">
              <span className="font-medium text-s-ink">{STATE_LABEL[av.state]}:</span> {av.message}
            </p>
          )}
          <DetailList title="What it does" items={a.capabilities} />
          <DetailList title="What its tools may do" items={a.permissions.map((p) => PERMISSION_LABEL[p])} />
          <DetailList title="Waits for your approval" items={a.approvals} />
          <DetailList title="Limitations" items={a.limitations} />
          <div>
            <h3 className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">Plans and charging</h3>
            <p className="mt-1.5 text-s-ink-2">
              <span className="text-s-ink">{plansLabel(a.plans)}.</span> {a.charging}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            {a.historyHref !== a.href && (
              <Link href={a.historyHref} className="inline-flex h-9 items-center rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium hover:bg-s-hover">
                Past tasks
              </Link>
            )}
            <Link href={a.href} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-s-accent px-3.5 text-[13px] font-medium text-s-accent-ink hover:brightness-110">
              Open {a.name} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function DetailList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3 className="text-[12.5px] font-semibold uppercase tracking-[0.06em] text-s-ink-3">{title}</h3>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-s-ink-2 marker:text-s-ink-3">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
