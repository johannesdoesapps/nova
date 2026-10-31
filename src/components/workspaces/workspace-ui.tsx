"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, Copy, Ellipsis, ExternalLink, Pencil, Search, Trash2 } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { ConfirmDialog } from "@/components/studio/dialogs";
import { Menu, MenuItem } from "@/components/studio/ui";
import { AgentAvatar } from "@/components/agents/agent-visuals";
import { workspaceAgents } from "@/lib/agents/builtins";
import type { AgentConfig } from "@/lib/agents/types";
import { CATALOGS, WORKSPACES, type WorkspaceKey, type WorkspaceTool } from "@/lib/workspaces/catalog";
import { cn, relativeTime } from "@/lib/utils";
import { WorkspaceIcon } from "./icons";

type View = "dashboard" | "agents" | "tools" | "templates" | "projects" | "search";

interface Item {
  id: string;
  kind: string;
  title: string;
  updatedAt: string;
}

const linkCls = "group glass flex flex-col rounded-[18px] p-4 transition hover:-translate-y-px hover:border-s-line-strong";

/** The in-workspace tab row shown in the header, so people move between the parts without the sidebar. */
function Tabs({ ws, view }: { ws: WorkspaceKey; view: View }) {
  const base = WORKSPACES[ws].base;
  const tabs: { id: View; label: string; href: string }[] = [
    { id: "dashboard", label: "Dashboard", href: base },
    { id: "agents", label: "Agents", href: `${base}/agents` },
    { id: "tools", label: "Tools", href: `${base}/tools` },
    { id: "templates", label: "Templates", href: `${base}/templates` },
    { id: "projects", label: "Projects", href: `${base}/projects` },
  ];
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
      <WorkspaceIcon name={WORKSPACES[ws].icon} className="h-4 w-4 shrink-0 text-s-ink-2" />
      <span className="mr-1 shrink-0 text-[14px] font-medium">{WORKSPACES[ws].label}</span>
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          aria-current={view === t.id ? "page" : undefined}
          className={cn("shrink-0 rounded-full px-3 py-1 text-[12.5px] transition", view === t.id ? "bg-s-ink text-s-bg" : "text-s-ink-2 hover:bg-s-hover hover:text-s-ink")}
        >
          {t.label}
        </Link>
      ))}
    </div>
  );
}

function Hero({ title, lead }: { title: string; lead: string }) {
  return (
    <div className="s-in">
      <h1 className="font-serif text-[clamp(30px,4.5vw,42px)] leading-[1.05] tracking-[-0.01em]">{title}</h1>
      <p className="mt-2 max-w-2xl text-[15px] text-s-ink-2">{lead}</p>
    </div>
  );
}

function AgentCard({ ws, agent }: { ws: WorkspaceKey; agent: AgentConfig }) {
  return (
    <Link href={`${WORKSPACES[ws].base}/agents/${agent.id}`} className={linkCls}>
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size="sm" />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{agent.name}</div>
          <p className="mt-0.5 line-clamp-2 text-[12.5px] text-s-ink-2">{agent.description}</p>
        </div>
      </div>
      <span className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-s-accent opacity-0 transition group-hover:opacity-100">
        Open <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
}

function ToolCard({ ws, tool }: { ws: WorkspaceKey; tool: WorkspaceTool }) {
  const base = WORKSPACES[ws].base;
  const href = tool.kind === "link" ? tool.href! : `${base}/tools/${tool.id}`;
  const external = tool.kind === "link";
  return (
    <Link href={href} className={linkCls}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-s-accent-soft text-s-accent [&_svg]:h-[18px] [&_svg]:w-[18px]">
          <WorkspaceIcon name={tool.icon} />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[14px] font-semibold">
            <span className="truncate">{tool.name}</span>
            {external && <ExternalLink className="h-3 w-3 shrink-0 text-s-ink-3" aria-label="Opens an Orbis tool" />}
            {tool.ai && <span className="shrink-0 rounded-full bg-s-accent-soft px-1.5 py-px text-[10px] font-medium text-s-accent">AI</span>}
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12.5px] text-s-ink-2">{tool.description}</p>
        </div>
      </div>
    </Link>
  );
}

function TemplateCard({ ws, id, name, description }: { ws: WorkspaceKey; id: string; name: string; description: string }) {
  return (
    <Link href={`${WORKSPACES[ws].base}/templates/${id}`} className={linkCls}>
      <div className="text-[14px] font-semibold">{name}</div>
      <p className="mt-1 line-clamp-2 text-[12.5px] text-s-ink-2">{description}</p>
    </Link>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</div>;
}

function SectionHead({ title, href, more }: { title: string; href?: string; more?: string }) {
  return (
    <div className="mt-9 mb-3 flex items-end justify-between gap-4">
      <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{title}</h2>
      {href && (
        <Link href={href} className="text-[13px] text-s-accent underline-offset-4 hover:underline">
          {more ?? "See all"}
        </Link>
      )}
    </div>
  );
}

/** One shell for every workspace view (dashboard, agents, tools, templates, projects, search). */
export function WorkspaceScreen({ ws, view, initialQuery = "" }: { ws: WorkspaceKey; view: View; initialQuery?: string }) {
  const router = useRouter();
  const meta = WORKSPACES[ws];
  const agents = useMemo(() => workspaceAgents(ws), [ws]);
  const catalog = CATALOGS[ws];
  const [query, setQuery] = useState(initialQuery);

  const toolGroups = useMemo(() => {
    const g = new Map<string, WorkspaceTool[]>();
    for (const t of catalog.tools) g.set(t.group, [...(g.get(t.group) ?? []), t]);
    return [...g.entries()];
  }, [catalog]);
  const templateGroups = useMemo(() => {
    const g = new Map<string, typeof catalog.templates>();
    for (const t of catalog.templates) g.set(t.group, [...(g.get(t.group) ?? []), t]);
    return [...g.entries()];
  }, [catalog]);

  const runSearch = (q: string) => {
    setQuery(q);
    if (view !== "search") router.push(`${meta.base}/search?q=${encodeURIComponent(q)}`);
  };

  return (
    <>
      <StudioHeader>
        <Tabs ws={ws} view={view} />
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1120px] px-4 pb-24 pt-3 sm:px-8">
          {view === "dashboard" && (
            <>
              <Hero title={meta.label} lead={meta.tagline} />
              <div className="s-in mt-6 [animation-delay:30ms]">
                <SearchBox base={meta.base} placeholder={`Search ${meta.label.toLowerCase()} agents, tools and templates`} />
              </div>
              <SectionHead title="AI agents" href={`${meta.base}/agents`} />
              <Grid>
                {agents.slice(0, 6).map((a) => (
                  <AgentCard key={a.id} ws={ws} agent={a} />
                ))}
              </Grid>
              <SectionHead title="Tools" href={`${meta.base}/tools`} />
              <Grid>
                {catalog.tools.slice(0, 6).map((t) => (
                  <ToolCard key={t.id} ws={ws} tool={t} />
                ))}
              </Grid>
              <SectionHead title="Templates" href={`${meta.base}/templates`} />
              <Grid>
                {catalog.templates.slice(0, 6).map((t) => (
                  <TemplateCard key={t.id} ws={ws} id={t.id} name={t.name} description={t.description} />
                ))}
              </Grid>
              <SectionHead title="Recent projects" href={`${meta.base}/projects`} />
              <Projects ws={ws} limit={6} />
            </>
          )}

          {view === "agents" && (
            <>
              <Hero title="AI agents" lead={`Specialised assistants for ${meta.label.toLowerCase()}. Each has its own workspace and conversation history.`} />
              <div className="mt-8" />
              <Grid>
                {agents.map((a) => (
                  <AgentCard key={a.id} ws={ws} agent={a} />
                ))}
              </Grid>
              {ws === "cyber" && (
                <>
                  <SectionHead title="Security Team" href="/agents/security" more="Open Security Team" />
                  <Grid>
                    <Link href="/agents/security" className={linkCls}>
                      <div className="flex items-start gap-3">
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-s-accent-soft text-s-accent [&_svg]:h-[18px] [&_svg]:w-[18px]">
                          <WorkspaceIcon name="shield" />
                        </span>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 text-[14px] font-semibold">
                            <span className="truncate">Security Team</span>
                            <ExternalLink className="h-3 w-3 shrink-0 text-s-ink-3" aria-label="Opens the Security Team" />
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[12.5px] text-s-ink-2">The full roster of security agents — scanning, monitoring, findings and schedules — working together.</p>
                        </div>
                      </div>
                    </Link>
                  </Grid>
                </>
              )}
            </>
          )}

          {view === "tools" && (
            <>
              <Hero title="Tools" lead="Run a task now. AI tools use your plan's allowance; the rest run instantly." />
              {toolGroups.map(([group, tools]) => (
                <div key={group}>
                  <SectionHead title={group} />
                  <Grid>
                    {tools.map((t) => (
                      <ToolCard key={t.id} ws={ws} tool={t} />
                    ))}
                  </Grid>
                </div>
              ))}
            </>
          )}

          {view === "templates" && (
            <>
              <Hero title="Templates" lead="Start from a ready-made document or layout; the AI fills it in from your brief, and you can edit and save it." />
              {templateGroups.map(([group, templates]) => (
                <div key={group}>
                  <SectionHead title={group} />
                  <Grid>
                    {templates.map((t) => (
                      <TemplateCard key={t.id} ws={ws} id={t.id} name={t.name} description={t.description} />
                    ))}
                  </Grid>
                </div>
              ))}
            </>
          )}

          {view === "projects" && (
            <>
              <Hero title="Projects" lead="Everything you've saved in this workspace. Open to edit, duplicate or delete." />
              <div className="mt-8" />
              <Projects ws={ws} />
            </>
          )}

          {view === "search" && <SearchView ws={ws} query={query} setQuery={runSearch} />}
        </div>
      </div>
    </>
  );
}

function SearchBox({ base, placeholder }: { base: string; placeholder: string }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        router.push(`${base}/search?q=${encodeURIComponent(q)}`);
      }}
      className="relative w-full sm:max-w-[420px]"
    >
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="glass h-10 w-full rounded-xl pl-10 pr-3 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong [&::-webkit-search-cancel-button]:hidden"
      />
    </form>
  );
}

function SearchView({ ws, query, setQuery }: { ws: WorkspaceKey; query: string; setQuery: (q: string) => void }) {
  const meta = WORKSPACES[ws];
  const agents = useMemo(() => workspaceAgents(ws), [ws]);
  const catalog = CATALOGS[ws];
  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const foundAgents = agents.filter((a) => hit(`${a.name} ${a.description}`));
  const foundTools = catalog.tools.filter((t) => hit(`${t.name} ${t.description} ${t.group}`));
  const foundTemplates = catalog.templates.filter((t) => hit(`${t.name} ${t.description} ${t.group}`));
  const none = q && !foundAgents.length && !foundTools.length && !foundTemplates.length;
  return (
    <>
      <Hero title="Search" lead={`Find an agent, tool or template in ${meta.label}.`} />
      <div className="s-in mt-6">
        <SearchInline value={query} onChange={setQuery} />
      </div>
      {none && <p className="mt-8 text-[14px] text-s-ink-2">Nothing matched “{query}”.</p>}
      {!!foundAgents.length && (
        <>
          <SectionHead title="Agents" />
          <Grid>
            {foundAgents.map((a) => (
              <AgentCard key={a.id} ws={ws} agent={a} />
            ))}
          </Grid>
        </>
      )}
      {!!foundTools.length && (
        <>
          <SectionHead title="Tools" />
          <Grid>
            {foundTools.map((t) => (
              <ToolCard key={t.id} ws={ws} tool={t} />
            ))}
          </Grid>
        </>
      )}
      {!!foundTemplates.length && (
        <>
          <SectionHead title="Templates" />
          <Grid>
            {foundTemplates.map((t) => (
              <TemplateCard key={t.id} ws={ws} id={t.id} name={t.name} description={t.description} />
            ))}
          </Grid>
        </>
      )}
    </>
  );
}

function SearchInline({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  return (
    <div className="relative w-full sm:max-w-[420px]">
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
      <input
        type="search"
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search agents, tools and templates"
        aria-label="Search this workspace"
        className="glass h-10 w-full rounded-xl pl-10 pr-3 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong [&::-webkit-search-cancel-button]:hidden"
      />
    </div>
  );
}

/** The saved items of a workspace, with open / rename / duplicate / delete. */
export function Projects({ ws, limit }: { ws: WorkspaceKey; limit?: number }) {
  const { user, integrations } = useApp();
  const router = useRouter();
  const base = WORKSPACES[ws].base;
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<Item | null>(null);
  const signedOut = integrations.supabase && !user;

  const load = useCallback(
    () =>
      signedOut
        ? Promise.resolve()
        : fetch(`/api/workspaces/${ws}/items`)
            .then((r) => {
              if (!r.ok) throw new Error(String(r.status));
              return r.json() as Promise<{ items: Item[] }>;
            })
            .then(
              (d) => setItems(d.items),
              () => setError("Your saved items couldn't be loaded."),
            ),
    [ws, signedOut],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (signedOut)
    return (
      <p className="text-[13.5px] text-s-ink-2">
        <Link href={`/login?next=${base}`} className="text-s-accent underline-offset-4 hover:underline">
          Sign in
        </Link>{" "}
        to save and reopen your work.
      </p>
    );
  if (error) return <p className="text-[13.5px] text-s-ink-3">{error}</p>;
  if (!items)
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Loading projects" role="status">
        {[0, 1, 2].map((i) => (
          <div key={i} className="s-skeleton h-24 rounded-[18px]" />
        ))}
      </div>
    );
  if (!items.length) return <p className="text-[13.5px] text-s-ink-2">No saved projects yet. Run a tool or template and save the result here.</p>;

  const shown = limit ? items.slice(0, limit) : items;
  const duplicate = async (it: Item) => {
    await fetch(`/api/workspaces/${ws}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ duplicateOf: it.id }) });
    void load();
  };
  const rename = async (it: Item) => {
    const title = window.prompt("Rename project", it.title)?.trim();
    if (!title || title === it.title) return;
    await fetch(`/api/workspaces/${ws}/items/${it.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
    void load();
  };
  const remove = async (it: Item) => {
    await fetch(`/api/workspaces/${ws}/items/${it.id}`, { method: "DELETE" });
    setToDelete(null);
    void load();
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((it) => (
          <div key={it.id} className="glass flex flex-col rounded-[18px] p-4">
            <div className="flex items-start justify-between gap-2">
              <button
                type="button"
                onClick={() =>
                  router.push(it.kind.startsWith("template:") ? `${base}/templates/${it.kind.slice(9)}?item=${it.id}` : `${base}/tools/${it.kind}?item=${it.id}`)
                }
                className="min-w-0 flex-1 text-left"
              >
                <div className="truncate text-[14px] font-semibold">{it.title}</div>
                <div className="mt-0.5 text-[12px] text-s-ink-3">{relativeTime(it.updatedAt)}</div>
              </button>
              <Menu label="Project actions" align="end" width={180} button={<Ellipsis className="h-4 w-4" />} buttonClassName="rounded-lg p-1.5 text-s-ink-3 hover:bg-s-hover hover:text-s-ink">
                <MenuItem icon={<Pencil />} onClick={() => rename(it)}>
                  Rename
                </MenuItem>
                <MenuItem icon={<Copy />} onClick={() => duplicate(it)}>
                  Duplicate
                </MenuItem>
                <MenuItem icon={<Trash2 />} danger onClick={() => setToDelete(it)}>
                  Delete
                </MenuItem>
              </Menu>
            </div>
          </div>
        ))}
      </div>
      <ConfirmDialog
        open={!!toDelete}
        title="Delete project?"
        description={toDelete ? `“${toDelete.title}” will be permanently deleted.` : ""}
        confirmLabel="Delete"
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (toDelete) await remove(toDelete);
        }}
      />
    </>
  );
}
