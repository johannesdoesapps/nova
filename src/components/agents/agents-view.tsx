"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { ArrowRight, CircleAlert, Copy, Ellipsis, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useModels } from "@/components/common/model-picker";
import { useApp } from "@/components/layout/app-context";
import { ConfirmDialog } from "@/components/studio/dialogs";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { iconButtonClass, Menu, MenuItem, MenuSeparator } from "@/components/studio/ui";
import type { AgentInput } from "@/lib/agents/schema";
import { CAPABILITY_INFO, type AgentConfig, type CapabilityStatus } from "@/lib/agents/types";
import { cn } from "@/lib/utils";
import { AgentEditor } from "./agent-editor";
import { AgentAvatar, CAPABILITY_ICONS } from "./agent-visuals";
import { agentStatus, deleteAgent, loadAgents, toInput, useAgents, type AgentStatus } from "./use-agents";

type Filter = "all" | "builtin" | "mine" | string;

export function AgentsView() {
  const router = useRouter();
  const { user, integrations } = useApp();
  const { notify } = useStudio();
  const state = useAgents();
  const models = useModels();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editor, setEditor] = useState<{ editing: AgentConfig | null; draft: AgentInput | null } | null>(null);
  const [toDelete, setToDelete] = useState<AgentConfig | null>(null);

  const blockedGuest = integrations.supabase && !user;
  const demo = !integrations.anthropic && !integrations.openai && !integrations.google && !integrations.deepseek && !integrations.huggingface;
  const ready = state.status === "ready" ? state : null;
  const all = useMemo(() => (ready ? [...ready.custom, ...ready.builtins] : []), [ready]);
  const categories = useMemo(() => [...new Set(ready?.builtins.map((a) => a.category) ?? [])], [ready]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((a) => {
      if (filter === "builtin" && a.kind !== "builtin") return false;
      if (filter === "mine" && a.kind !== "custom") return false;
      if (!["all", "builtin", "mine"].includes(filter) && a.category !== filter) return false;
      return !q || `${a.name} ${a.description} ${a.category}`.toLowerCase().includes(q);
    });
  }, [all, filter, query]);

  const create = () => setEditor({ editing: null, draft: null });
  const duplicate = (a: AgentConfig) => setEditor({ editing: null, draft: { ...toInput(a), name: `${a.name} (copy)`.slice(0, 80) } });

  const filters: { id: Filter; label: string }[] = [
    { id: "all", label: "All" },
    { id: "builtin", label: "Built-in" },
    { id: "mine", label: `My agents${ready?.custom.length ? ` · ${ready.custom.length}` : ""}` },
    ...categories.map((c) => ({ id: c, label: c })),
  ];

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Agents</span>
      </StudioHeader>

      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1120px] px-4 pb-20 pt-2 sm:px-8">
          <div className="s-in flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div>
              <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">AI Agents</h1>
              <p className="mt-2 text-[15.5px] text-s-ink-2">Your specialized AI assistants, ready to work.</p>
            </div>
            <button
              type="button"
              onClick={create}
              disabled={!ready || blockedGuest}
              className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink shadow-[0_8px_24px_-10px_var(--s-accent)] transition hover:-translate-y-px hover:brightness-110 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50"
            >
              <Plus className="h-4 w-4" /> Create agent
            </button>
          </div>

          <div className="s-in mt-7 flex flex-col gap-3 [animation-delay:60ms] lg:flex-row lg:items-center">
            <div className="relative w-full lg:max-w-[320px]">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search agents"
                aria-label="Search agents"
                className="glass h-10 w-full rounded-xl pl-10 pr-3 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            <div role="tablist" aria-label="Filter agents" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:px-0 lg:pb-0">
              {filters.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={cn(
                    "h-9 shrink-0 rounded-full border px-3.5 text-[13px] transition duration-200",
                    filter === f.id ? "border-transparent bg-s-ink text-s-bg" : "border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink",
                  )}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {blockedGuest ? (
            <p className="mt-4 text-[13px] text-s-ink-3">
              <Link href="/login?next=/agents" className="text-s-accent underline-offset-4 hover:underline">
                Sign in
              </Link>{" "}
              to create agents and chat with them.
            </p>
          ) : ready?.persistence === "local" ? (
            <p className="mt-4 text-[13px] text-s-ink-3">You’re using NOVA without an account, so agents you create are saved in this browser only.</p>
          ) : null}

          <div className="mt-6">
            {state.status === "loading" ? (
              <Grid>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="glass h-[188px] rounded-[22px] p-5">
                    <div className="flex gap-3.5">
                      <div className="s-skeleton h-11 w-11 rounded-[14px]" />
                      <div className="flex-1 space-y-2 pt-1">
                        <div className="s-skeleton h-4 w-2/3" />
                        <div className="s-skeleton h-3 w-1/3" />
                      </div>
                    </div>
                    <div className="s-skeleton mt-5 h-3 w-full" />
                    <div className="s-skeleton mt-2 h-3 w-4/5" />
                  </div>
                ))}
              </Grid>
            ) : state.status === "error" ? (
              <div role="alert" className="glass mx-auto flex max-w-md flex-col items-center rounded-[22px] px-6 py-10 text-center">
                <CircleAlert className="h-6 w-6 text-s-danger" />
                <h2 className="mt-3 text-[16px] font-semibold">Agents couldn’t be loaded</h2>
                <p className="mt-1 text-[14px] text-s-ink-2">{state.message}</p>
                <button type="button" onClick={() => void loadAgents()} className="mt-5 rounded-xl border border-s-line-strong px-4 py-2 text-[13.5px] font-medium transition hover:bg-s-hover">
                  Try again
                </button>
              </div>
            ) : visible.length === 0 ? (
              <div className="mx-auto flex max-w-md flex-col items-center rounded-[22px] border border-dashed border-s-line-strong px-6 py-12 text-center">
                {filter === "mine" && !query ? (
                  <>
                    <h2 className="text-[16px] font-semibold">No agents of your own yet</h2>
                    <p className="mt-1 text-[14px] text-s-ink-2">Create one with its own instructions and tools, or duplicate a built-in agent and adjust it.</p>
                    <button type="button" onClick={create} disabled={blockedGuest} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-50">
                      <Plus className="h-4 w-4" /> Create agent
                    </button>
                  </>
                ) : (
                  <>
                    <h2 className="text-[16px] font-semibold">No agents match</h2>
                    <p className="mt-1 text-[14px] text-s-ink-2">Try another search or filter.</p>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        setFilter("all");
                      }}
                      className="mt-5 rounded-xl border border-s-line-strong px-4 py-2 text-[13.5px] font-medium transition hover:bg-s-hover"
                    >
                      Clear filters
                    </button>
                  </>
                )}
              </div>
            ) : (
              <Grid>
                {visible.map((a, i) => (
                  <AgentCard
                    key={a.id}
                    agent={a}
                    index={i}
                    status={agentStatus(a, ready!.capabilities, models, demo)}
                    capabilities={ready!.capabilities}
                    onEdit={() => setEditor({ editing: a, draft: null })}
                    onDuplicate={() => duplicate(a)}
                    onDelete={() => setToDelete(a)}
                  />
                ))}
              </Grid>
            )}
          </div>
        </div>
      </div>

      {ready && (
        <AgentEditor
          open={!!editor}
          editing={editor?.editing ?? null}
          draft={editor?.draft ?? null}
          capabilities={ready.capabilities}
          models={models}
          onClose={() => setEditor(null)}
          onSaved={(agent, created) => {
            setEditor(null);
            notify(created ? `${agent.name} created` : "Changes saved");
            if (created) router.push(`/agents/${agent.id}`);
          }}
        />
      )}
      <ConfirmDialog
        open={!!toDelete}
        title={`Delete ${toDelete?.name ?? "agent"}?`}
        description="The agent and all of its conversations will be permanently deleted."
        confirmLabel="Delete agent"
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          await deleteAgent(toDelete!.id);
          notify("Agent deleted");
        }}
      />
    </>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
}

const STATUS_DOT: Record<AgentStatus["tone"], string> = {
  ok: "bg-[#3f9f62]",
  warn: "bg-[#c98a1c]",
  muted: "bg-s-ink-3",
};

function AgentCard({
  agent,
  index,
  status,
  capabilities,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  agent: AgentConfig;
  index: number;
  status: AgentStatus;
  capabilities: CapabilityStatus;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const custom = agent.kind === "custom";
  return (
    <article
      className="glass group relative flex flex-col rounded-[22px] p-5 transition duration-300 hover:-translate-y-0.5 hover:border-s-line-strong hover:bg-s-glass-strong hover:shadow-[var(--s-shadow)]"
      style={{ animation: `s-in .34s cubic-bezier(.2,.7,.2,1) ${Math.min(index, 8) * 35}ms both` }}
    >
      <div className="flex items-start gap-3.5">
        <AgentAvatar agent={agent} />
        <div className="min-w-0 flex-1 pt-0.5">
          <h2 className="truncate text-[15.5px] font-semibold tracking-[-0.01em]">
            <Link href={`/agents/${agent.id}`} className="outline-none after:absolute after:inset-0 after:rounded-[22px] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-[var(--s-ring)]">
              {agent.name}
            </Link>
          </h2>
          <p className="mt-1 flex min-w-0 items-center gap-x-2 whitespace-nowrap text-[12.5px] text-s-ink-3">
            <span>{custom ? "Custom" : agent.category}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex min-w-0 items-center gap-1.5" title={status.detail}>
              <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status.tone])} aria-hidden />
              {status.label}
            </span>
          </p>
        </div>
        <div className="relative z-10 -mr-1.5 -mt-1">
          <Menu
            label={`Options for ${agent.name}`}
            side="auto"
            align="end"
            width={220}
            buttonLabel={`Options for ${agent.name}`}
            buttonClassName={iconButtonClass("sm")}
            button={<Ellipsis />}
          >
            {custom && (
              <MenuItem icon={<Pencil />} onClick={onEdit}>
                Edit agent
              </MenuItem>
            )}
            <MenuItem icon={<Copy />} hint={custom ? undefined : "Make your own editable version"} onClick={onDuplicate}>
              Duplicate
            </MenuItem>
            {custom && (
              <>
                <MenuSeparator />
                <MenuItem icon={<Trash2 />} danger onClick={onDelete}>
                  Delete agent
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>

      <p className="mt-3.5 line-clamp-2 min-h-[2.9em] text-[13.5px] leading-relaxed text-s-ink-2">{agent.description || "No description."}</p>

      <div className="mt-4 flex items-center justify-between gap-3">
        <ul className="flex items-center gap-1" aria-label="Capabilities">
          {agent.capabilities.length === 0 ? (
            <li className="text-[12px] text-s-ink-3">Conversation only</li>
          ) : (
            agent.capabilities.map((c) => (
              <li
                key={c}
                title={`${CAPABILITY_INFO[c].label}${capabilities[c].available ? "" : " (needs setup)"}`}
                className={cn(
                  "grid h-7 w-7 place-items-center rounded-lg border border-s-line [&_svg]:h-3.5 [&_svg]:w-3.5",
                  capabilities[c].available ? "text-s-ink-2" : "text-s-ink-3 opacity-60",
                )}
              >
                {CAPABILITY_ICONS[c]}
                <span className="sr-only">{CAPABILITY_INFO[c].label}</span>
              </li>
            ))
          )}
        </ul>
        <span className="relative inline-flex h-9 items-center gap-1.5 rounded-xl border border-s-line-strong px-3.5 text-[13px] font-medium transition duration-200 group-hover:border-transparent group-hover:bg-s-accent group-hover:text-s-accent-ink" aria-hidden>
          Open agent <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </article>
  );
}
