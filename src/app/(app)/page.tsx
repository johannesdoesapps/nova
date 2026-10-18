import Link from "next/link";
import { ArrowUpRight, Compass, Cpu, FolderKanban, MessageSquare, Search, Star, Swords } from "lucide-react";
import { HeroSearch } from "@/components/search/hero-search";
import { Badge, Card } from "@/components/ui/primitives";
import { listFavorites, listRecentSearches } from "@/lib/db";
import { loadShellData } from "@/lib/session-data";
import { usageSummary } from "@/lib/usage";
import { formatUsd, relativeTime } from "@/lib/utils";

const FEATURES = [
  { href: "/search", icon: Search, title: "AI Search", text: "Answers grounded in live web sources, with citations you can check." },
  { href: "/chat", icon: MessageSquare, title: "AI Chat", text: "Research, Analyst, Critic and Coding modes with saved history." },
  { href: "/battle", icon: Swords, title: "Model Battle", text: "One prompt, several models, side by side with latency and usage." },
  { href: "/models", icon: Cpu, title: "Model Router", text: "Transparent rules that suggest a model for your task." },
  { href: "/discover", icon: Compass, title: "Model Discovery", text: "Browse Hugging Face models and datasets without leaving NOVARA." },
  { href: "/projects", icon: FolderKanban, title: "Research Projects", text: "Collect searches, chats, comparisons and notes in one place." },
];

export default async function DashboardPage() {
  const { auth, recents, integrations } = await loadShellData();
  const signedIn = auth.mode === "authenticated";
  const [favorites, searches, usage] = signedIn
    ? await Promise.all([
        listFavorites(auth.supabase, auth.user.id).catch(() => []),
        listRecentSearches(auth.supabase, auth.user.id, 6).catch(() => []),
        usageSummary(auth),
      ])
    : [[], [], null];
  const name = auth.user?.displayName?.split(" ")[0];

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16 pt-10 sm:px-6 lg:pt-16">
      <section className="mx-auto max-w-3xl text-center">
        <Badge tone="accent" className="mb-5">Discover Knowledge · Access AI · Turn Ideas into Action</Badge>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-[42px] sm:leading-[1.1]">
          <span className="nova-gradient-text">{name ? `Welcome back, ${name}.` : "What would you like to discover today?"}</span>
        </h1>
        {name && <p className="mt-3 text-muted">What would you like to discover today?</p>}
        <div className="mt-8 text-left">
          <HeroSearch />
        </div>
        {!integrations.openai && !integrations.huggingface && (
          <p className="mt-4 text-xs text-faint">
            No AI provider is configured — answers will be labelled as simulated. <Link className="text-accent hover:underline" href="/settings">Set up keys</Link>
          </p>
        )}
      </section>

      <section className="mt-14 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f) => {
          const Icon = f.icon;
          return (
            <Link key={f.href} href={f.href} className="group">
              <Card className="h-full p-4 transition hover:border-accent/40 hover:bg-panel-2">
                <div className="flex items-center justify-between">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-accent-soft text-accent">
                    <Icon className="h-[18px] w-[18px]" />
                  </span>
                  <ArrowUpRight className="h-4 w-4 text-faint opacity-0 transition group-hover:opacity-100" />
                </div>
                <div className="mt-3 font-medium">{f.title}</div>
                <p className="mt-1 text-sm text-muted">{f.text}</p>
              </Card>
            </Link>
          );
        })}
      </section>

      <section className="mt-10 grid gap-4 lg:grid-cols-3">
        <Panel title="Recent conversations" href="/chat" empty={!signedIn ? "Sign in to keep your conversation history." : "No conversations yet — start a chat."}>
          {recents.conversations.slice(0, 5).map((c) => (
            <Row key={c.id} href={`/chat?c=${c.id}`} title={c.title} meta={relativeTime(c.updated_at)} />
          ))}
        </Panel>
        <Panel title="Recent projects" href="/projects" empty={!signedIn ? "Sign in to create research projects." : "No projects yet."}>
          {recents.projects.slice(0, 5).map((p) => (
            <Row key={p.id} href={`/projects/${p.id}`} title={p.name} meta={relativeTime(p.updated_at)} />
          ))}
        </Panel>
        <Panel title="Recent activity" href="/search" empty={!signedIn ? "Your searches appear here once you sign in." : "No searches yet."}>
          {searches.map((s) => (
            <Row key={s.id} href={`/search?q=${encodeURIComponent(s.query)}`} title={s.query} meta={relativeTime(s.created_at)} icon={<Search className="h-3.5 w-3.5" />} />
          ))}
        </Panel>
        <Panel title="Favourite models" href="/discover" empty={!signedIn ? "Sign in to save favourite models." : "Star models in Discovery to pin them here."}>
          {favorites.slice(0, 5).map((f) => (
            <Row key={f.id} href={`https://huggingface.co/${f.model_id}`} external title={f.model_id} icon={<Star className="h-3.5 w-3.5" />} />
          ))}
        </Panel>
        <Card className="p-4 lg:col-span-2">
          <div className="text-sm font-medium">Usage today</div>
          {usage ? (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Model runs" value={`${usage.runsToday} / ${usage.dailyLimit}`} />
              <Stat
                label="Estimated cost"
                value={usage.estimatedCostToday === null ? "n/a" : formatUsd(usage.estimatedCostToday)}
                hint={usage.estimatedCostToday === null ? "No verified prices configured" : usage.costIsPartial ? "Some models have no price" : "Estimate"}
              />
              <Stat label="Resets" value="00:00 UTC" />
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted">Usage tracking is available for signed-in users.</p>
          )}
        </Card>
      </section>
    </div>
  );
}

function Panel({ title, href, empty, children }: { title: string; href: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium">{title}</div>
        <Link href={href} className="text-xs text-faint hover:text-fg">View all</Link>
      </div>
      {items.length ? <div className="-mx-2 space-y-0.5">{items}</div> : <p className="py-3 text-sm text-faint">{empty}</p>}
    </Card>
  );
}

function Row({ href, title, meta, icon, external }: { href: string; title: string; meta?: string; icon?: React.ReactNode; external?: boolean }) {
  return (
    <Link
      href={href}
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-panel-2 hover:text-fg"
    >
      {icon && <span className="text-faint">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {meta && <span className="shrink-0 text-xs text-faint">{meta}</span>}
    </Link>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-bg-elev p-3">
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
    </div>
  );
}
