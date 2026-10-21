"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  Bug,
  CalendarDays,
  ChartColumn,
  Check,
  Code2,
  Ellipsis,
  EyeOff,
  FileText,
  Flag,
  Flame,
  FolderPlus,
  Globe,
  GraduationCap,
  Lightbulb,
  MessageSquare,
  PenLine,
  Pin,
  PinOff,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Scale,
  SlidersHorizontal,
  Sparkles,
  Swords,
  Telescope,
  Users,
  X,
} from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { jsonFetch } from "@/hooks/use-ndjson";
import { useLocalStorage } from "@/hooks/use-local-storage";
import {
  ago,
  dailyPicks,
  discoverFor,
  FOCUS_LIMIT,
  greetingFor,
  HOME_SECTIONS,
  homeActionById,
  localDay,
  planDayPrompt,
  QUICK_TOOLS,
  readPrefs,
  type DayEvent,
  type DiscoverItem,
  type HomeAction,
  type HomeConversation,
  type HomeData,
  type HomePrefs,
  type HomePrefsPatch,
  type HomeSectionId,
  type IconName,
} from "@/lib/home";
import type { StarterTask, StarterTaskId } from "@/lib/starter";
import { cn } from "@/lib/utils";
import { useStudio } from "./frame";
import { useSavedPrompts } from "./prefs";
import { UsageSummary, useUsage } from "./usage";
import { AgentAvatar } from "@/components/agents/agent-visuals";
import { useAgents } from "@/components/agents/use-agents";
import { TaskStarter, type StarterEnv } from "./task-starter";
import { Dialog, iconButtonClass, Menu, MenuItem, Switch } from "./ui";

export const HOME_ICONS: Record<IconName, ReactNode> = {
  telescope: <Telescope />,
  users: <Users />,
  swords: <Swords />,
  globe: <Globe />,
  bug: <Bug />,
  file: <FileText />,
  bot: <Bot />,
  flag: <Flag />,
  plug: <Plug />,
  play: <Play />,
  flame: <Flame />,
  scale: <Scale />,
  graduation: <GraduationCap />,
  pen: <PenLine />,
  lightbulb: <Lightbulb />,
  chart: <ChartColumn />,
  code: <Code2 />,
  sparkles: <Sparkles />,
};

const noSubscribe = () => () => {};
type Loaded = HomeData & { errors: string[] };
type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: Loaded };

/** The signed-in home's data; guests get an empty home built from this browser's chats. */
function useHomeData(signedIn: boolean) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    jsonFetch<Loaded>("/api/home")
      .then((data) => alive && setState({ status: "ready", data }))
      .catch((e: Error) => alive && setState({ status: "error", message: e.message }));
    return () => {
      alive = false;
    };
  }, [signedIn, attempt]);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setAttempt((n) => n + 1);
  }, []);
  return { state, retry };
}

/** Home preferences: the user's profile when signed in (saved as they change), this browser otherwise. */
function useHomePrefs(signedIn: boolean, loaded: HomePrefs | null, notify: (t: string) => void) {
  const [local, setLocal] = useLocalStorage("orbis:home");
  const [server, setServer] = useState<HomePrefs | null>(null);
  const guestPrefs = useMemo(() => {
    try {
      return readPrefs(local ? JSON.parse(local) : null);
    } catch {
      return readPrefs(null);
    }
  }, [local]);
  const prefs = signedIn ? (server ?? loaded ?? readPrefs(null)) : guestPrefs;

  const update = useCallback(
    (patch: HomePrefsPatch) => {
      const next = { ...prefs, ...patch } as HomePrefs;
      if (!signedIn) return setLocal(JSON.stringify(next));
      setServer(next);
      jsonFetch<{ prefs: HomePrefs }>("/api/home", { method: "PATCH", body: JSON.stringify(patch) }).catch((e: Error) => {
        setServer(prefs);
        notify(`Couldn’t save that: ${e.message}`);
      });
    },
    [prefs, signedIn, setLocal, notify],
  );
  return { prefs, update };
}

export interface HomeProps {
  name: string | null;
  composer: ReactNode;
  onAction: (a: HomeAction) => void;
  notice?: ReactNode;
  starter: { active: StarterTaskId | null; onChoose: (task: StarterTask | null) => void; env: StarterEnv };
}

/** The start page: one question, the prompt box, the task starter, and the user's own work. */
export function Home({ name, composer, onAction, notice, starter }: HomeProps) {
  const { user, integrations } = useApp();
  const studio = useStudio();
  const router = useRouter();
  const params = useSearchParams();
  const signedIn = !!user;
  const { state, retry } = useHomeData(signedIn);
  const data = state.status === "ready" ? state.data : null;
  const { prefs, update } = useHomePrefs(signedIn, data?.prefs ?? null, studio.notify);
  const [customizing, setCustomizing] = useState(false);

  // The time is only known in the browser; render placeholders on the server.
  const now = useSyncExternalStore(
    noSubscribe,
    () => Math.floor(Date.now() / 60_000),
    () => null,
  );
  const date = now === null ? null : new Date(now * 60_000);
  const today = date ? localDay(date) : null;

  // "/home?try=<id>" (from Discover and elsewhere): run that suggestion here once.
  const tryId = params.get("try");
  useEffect(() => {
    if (!tryId) return;
    const a = homeActionById(tryId);
    router.replace("/home", { scroll: false });
    if (a) onAction(a);
  }, [tryId, onAction, router]);

  // Guests: this browser's chats.
  const guestConversations: HomeConversation[] = useMemo(
    () => (studio.conversations ?? []).slice(0, 6).map((c) => ({ id: c.id, title: c.title, mode: c.mode, updatedAt: c.updated_at, preview: null })),
    [studio.conversations],
  );
  const conversations = signedIn ? (data?.conversations ?? null) : studio.conversations === null ? null : guestConversations;
  const projects = data?.projects ?? (signedIn ? null : []);
  const tasks = data?.tasks ?? (signedIn ? null : []);
  const calendar: HomeData["calendar"] = data?.calendar ?? "unavailable";
  const failed = (part: string) => state.status === "error" || !!data?.errors.includes(part);

  const events = useDayEvents(calendar === "connected" ? date : null);

  const focusItems = today && prefs.focus?.day === today ? prefs.focus.items : [];
  const leftover = today && prefs.focus && prefs.focus.day !== today ? prefs.focus.items.filter((i) => !i.done) : [];

  const planDay = () => {
    if (!date) return;
    onAction({
      kind: "send",
      mode: "analyst",
      prompt: planDayPrompt({
        date: date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }),
        focus: focusItems.filter((f) => !f.done).map((f) => f.text),
        tasks: (tasks ?? []).slice(0, 5).map((t) => ({ title: t.title, project: t.project })),
        events: events.status === "ready" ? events.events.map((e) => ({ title: e.title, when: e.allDay ? "All day" : timeOf(e.start) })) : [],
        calendar: calendar === "connected" && events.status === "ready" ? "connected" : calendar === "unavailable" ? "unavailable" : "not_connected",
      }),
    });
  };
  const runAction = (a: HomeAction) => (a.kind === "send" && !a.prompt ? planDay() : onAction(a));

  const shown = (id: HomeSectionId) => !prefs.hidden.includes(id);
  const hide = (id: HomeSectionId) => {
    update({ hidden: [...new Set([...prefs.hidden, id])] });
    studio.notify("Section hidden. Bring it back from Customize.");
  };

  const greeting = date ? greetingFor(date.getHours(), name) : null;
  const discover = useMemo(() => (today ? dailyPicks(discoverFor({ search: integrations.search }), today, prefs.dismissed) : []), [today, integrations.search, prefs.dismissed]);
  const resume = pickResume(projects, conversations);
  const loading = signedIn && state.status === "loading";
  const usage = useUsage();

  return (
    <div className="mx-auto w-full max-w-[1080px] px-4 pb-24 pt-6 sm:px-6 sm:pt-10 lg:pt-14">
      <div className="mx-auto flex max-w-[760px] flex-col items-center text-center">
        <p className="s-in h-5 text-[13.5px] text-s-ink-3" suppressHydrationWarning>
          {greeting && date ? `${greeting} · ${date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}` : " "}
        </p>
        <h1 className="s-in mt-1.5 text-balance font-serif text-[clamp(32px,5.6vw,48px)] leading-[1.08] tracking-[-0.01em] [animation-delay:40ms]">What do you want to accomplish?</h1>
        <div className="s-in mt-7 w-full text-left [animation-delay:120ms]">{composer}</div>
        <TaskStarter active={starter.active} onChoose={starter.onChoose} onAction={runAction} env={starter.env} home />
        {notice && <div className="mt-5 text-center text-[12.5px] text-s-ink-3">{notice}</div>}
      </div>

      <div className="s-in mt-12 flex items-center gap-2 [animation-delay:220ms]">
        <h2 className="text-[12px] font-medium uppercase tracking-[0.08em] text-s-ink-3">{signedIn ? "Your workspace" : "Get started"}</h2>
        {signedIn && usage && (
          <p className="hidden min-w-0 truncate text-[12.5px] text-s-ink-3 sm:block">
            <span aria-hidden>· </span>
            <UsageSummary usage={usage} detailsHref="/usage" />
          </p>
        )}
        <button
          type="button"
          onClick={() => setCustomizing(true)}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-s-ink-3 transition hover:bg-s-hover hover:text-s-ink [&_svg]:h-3.5 [&_svg]:w-3.5"
        >
          <SlidersHorizontal />
          Customize
        </button>
      </div>

      {state.status === "error" && (
        <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-s-line px-4 py-3 text-[13.5px] text-s-ink-2">
          Your workspace couldn’t load: {state.message}
          <button
            type="button"
            onClick={retry}
            className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-s-line-strong px-3 py-1 text-[12.5px] text-s-ink hover:bg-s-hover [&_svg]:h-3.5 [&_svg]:w-3.5"
          >
            <RefreshCw /> Try again
          </button>
        </div>
      )}

      <div className="s-in mt-3 grid gap-3 [animation-delay:260ms] lg:grid-cols-2">
        {shown("continue") && resume && (
          <Section id="continue" title="Pick up where you left off" icon={<RefreshCw />} onHide={hide} className="lg:col-span-2">
            <Link href={resume.href} className="group -m-1.5 flex items-center gap-3 rounded-2xl p-1.5 transition hover:bg-s-hover">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-s-accent-soft text-s-ink-2 [&_svg]:h-[18px] [&_svg]:w-[18px]">{resume.icon}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14.5px] font-medium">{resume.title}</span>
                <span className="block truncate text-[13px] text-s-ink-3">{resume.detail}</span>
              </span>
              <span className="hidden shrink-0 items-center gap-1 text-[13px] text-s-ink-2 group-hover:text-s-ink sm:inline-flex">
                Continue <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
              </span>
            </Link>
          </Section>
        )}

        {shown("conversations") && (
          <Section
            id="conversations"
            title="Recent conversations"
            icon={<MessageSquare />}
            onHide={hide}
            footer={conversations?.length ? { href: signedIn ? "/history" : "/chat", label: signedIn ? "All conversations" : "Open chat" } : undefined}
          >
            {conversations === null && failed("conversations") ? (
              <PartError what="your conversations" onRetry={retry} />
            ) : conversations === null ? (
              <Rows />
            ) : failed("conversations") ? (
              <PartError what="your conversations" onRetry={retry} />
            ) : conversations.length === 0 ? (
              <Empty
                text={signedIn ? "No conversations yet. Ask something above and it’ll be here when you come back." : "No chats in this browser yet. Sign in to keep your conversations across devices."}
              />
            ) : (
              <ul className="-mx-1.5 flex flex-col">
                {conversations.slice(0, 5).map((c) => (
                  <li key={c.id}>
                    <Link href={`/chat?c=${c.id}`} className="group flex items-start gap-3 rounded-xl px-1.5 py-2 transition hover:bg-s-hover">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-s-ink">{c.title}</span>
                        {c.preview && <span className="mt-0.5 block truncate text-[12.5px] text-s-ink-3">{c.preview}</span>}
                      </span>
                      <time dateTime={c.updatedAt} className="mt-0.5 shrink-0 text-[12px] text-s-ink-3" suppressHydrationWarning>
                        {now === null ? "" : ago(c.updatedAt, now * 60_000)}
                      </time>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}

        {shown("agents") && (
          <Section id="agents" title="Agents and shortcuts" icon={<Bot />} onHide={hide} footer={{ href: "/agents", label: "All agents" }}>
            <AgentsAndShortcuts
              pinned={prefs.pinnedAgents}
              onPin={(id) => update({ pinnedAgents: prefs.pinnedAgents.includes(id) ? prefs.pinnedAgents.filter((p) => p !== id) : [id, ...prefs.pinnedAgents].slice(0, 12) })}
              onPrompt={(text) => onAction({ kind: "draft", prompt: text, mode: studio.settings.defaultMode })}
              onManagePrompts={studio.openPrompts}
            />
          </Section>
        )}

        {shown("day") && (
          <Section id="day" title="My day" icon={<CalendarDays />} onHide={hide}>
            <FocusList items={focusItems} leftover={leftover} onChange={(items) => today && update({ focus: { day: today, items } })} />
            {signedIn &&
              (tasks === null ? (
                loading ? (
                  <Rows n={2} />
                ) : null
              ) : (
                tasks.length > 0 && (
                  <div className="mt-4">
                    <h3 className="mb-1.5 text-[12px] font-medium text-s-ink-3">From your missions</h3>
                    <ul className="flex flex-col gap-1">
                      {tasks.slice(0, 4).map((t) => (
                        <li key={t.id}>
                          <Link href={t.href} className="-mx-1.5 flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-[13.5px] transition hover:bg-s-hover">
                            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.status === "in_progress" ? "bg-s-brand" : t.status === "blocked" ? "bg-s-danger" : "bg-s-ink-3")} aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{t.title}</span>
                            <span className="shrink-0 text-[12px] text-s-ink-3">
                              {t.status === "in_progress" ? "In progress" : t.status === "blocked" ? "Blocked" : t.priority === "high" ? "High priority" : t.project}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              ))}
            <CalendarBlock signedIn={signedIn} state={loading ? null : calendar} events={events} />
            <button
              type="button"
              onClick={planDay}
              disabled={!date}
              className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-full bg-s-accent px-4 text-[13px] font-medium text-s-accent-ink transition hover:opacity-90 active:scale-[0.98] disabled:opacity-50 [&_svg]:h-3.5 [&_svg]:w-3.5"
            >
              <Sparkles /> Plan my day with AI
            </button>
          </Section>
        )}

        {shown("projects") && (
          <Section
            id="projects"
            title="My projects"
            icon={<FolderPlus />}
            onHide={hide}
            action={signedIn ? <NewProjectMenu /> : undefined}
            footer={projects?.length ? { href: "/projects", label: "All projects" } : undefined}
          >
            {!signedIn ? (
              <Empty text="Projects keep longer work together: code the agent edits and tests, or a mission with milestones and tasks.">
                <Link href="/login?next=/home" className="text-s-ink underline-offset-4 hover:underline">
                  Sign in to start one
                </Link>
              </Empty>
            ) : failed("code") && failed("missions") ? (
              <PartError what="your projects" onRetry={retry} />
            ) : projects === null ? (
              <Rows />
            ) : projects.length === 0 ? (
              <Empty text="No projects yet. Build software with the coding agent, or turn a goal into a plan you can work through.">
                <span className="flex flex-wrap gap-2">
                  <Pill href="/code">Start a code project</Pill>
                  <Pill href="/missions">Plan a mission</Pill>
                </span>
              </Empty>
            ) : (
              <ul className="-mx-1.5 flex flex-col">
                {projects.slice(0, 5).map((p) => (
                  <li key={`${p.kind}:${p.id}`}>
                    <Link href={p.href} className="flex items-center gap-3 rounded-xl px-1.5 py-2 transition hover:bg-s-hover">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-s-line text-s-ink-2 [&_svg]:h-4 [&_svg]:w-4">{p.kind === "code" ? <Code2 /> : <Flag />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium">{p.name}</span>
                        <span className={cn("block truncate text-[12.5px]", p.attention ? "text-s-brand" : "text-s-ink-3")}>{p.attention ?? p.detail}</span>
                      </span>
                      <time dateTime={p.updatedAt} className="shrink-0 text-[12px] text-s-ink-3" suppressHydrationWarning>
                        {now === null ? "" : ago(p.updatedAt, now * 60_000)}
                      </time>
                    </Link>
                  </li>
                ))}
                {(failed("code") || failed("missions")) && <li className="px-1.5 pt-1 text-[12.5px] text-s-ink-3">Some projects couldn’t load ({failed("code") ? "code" : "missions"}).</li>}
              </ul>
            )}
          </Section>
        )}

        {shown("tools") && (
          <Section id="tools" title="Quick tools" icon={<Sparkles />} onHide={hide}>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {QUICK_TOOLS.map((t) => (
                <li key={t.id}>
                  <ActionButton
                    action={t.action}
                    onAction={runAction}
                    title={t.hint}
                    className="flex h-full w-full flex-col items-start gap-2 rounded-2xl border border-s-line p-3 text-left text-[13px] font-medium transition hover:border-s-line-strong hover:bg-s-hover active:scale-[0.98] [&_svg]:h-4 [&_svg]:w-4"
                  >
                    <span className="text-s-ink-2">{HOME_ICONS[t.icon]}</span>
                    {t.label}
                    <span className="sr-only">: {t.hint}</span>
                  </ActionButton>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {shown("discover") && (
          <Section id="discover" title="Discover" icon={<Telescope />} onHide={hide} className="lg:col-span-2" footer={{ href: "/discover", label: "Explore everything Orbis can do" }}>
            {discover.length === 0 ? (
              today ? (
                <Empty text="You’ve dismissed every suggestion.">
                  <button type="button" onClick={() => update({ dismissed: [] })} className="text-s-ink underline-offset-4 hover:underline">
                    Show them again
                  </button>
                </Empty>
              ) : (
                <Rows n={2} />
              )
            ) : (
              <ul className="grid gap-2 md:grid-cols-3">
                {discover.map((d) => (
                  <DiscoverCard key={d.id} item={d} onAction={runAction} onDismiss={() => update({ dismissed: [...prefs.dismissed, d.id].slice(-60) })} />
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>

      {HOME_SECTIONS.every((s) => !shown(s.id)) && (
        <p className="mt-6 text-center text-[13px] text-s-ink-3">
          Every section is hidden.{" "}
          <button type="button" onClick={() => setCustomizing(true)} className="text-s-ink underline-offset-4 hover:underline">
            Customize
          </button>
        </p>
      )}

      <Dialog open={customizing} onClose={() => setCustomizing(false)} title="Customize your home" description={signedIn ? "Saved to your account." : "Saved in this browser."} width={420}>
        <ul className="flex flex-col">
          {HOME_SECTIONS.map((s) => (
            <li key={s.id} className="flex items-center justify-between gap-4 border-b border-s-line py-2.5 last:border-0">
              <span className="text-[14px]">{s.label}</span>
              <Switch label={`Show ${s.label}`} checked={shown(s.id)} onChange={(on) => update({ hidden: on ? prefs.hidden.filter((h) => h !== s.id) : [...prefs.hidden, s.id] })} />
            </li>
          ))}
        </ul>
        {prefs.dismissed.length > 0 && (
          <button type="button" onClick={() => update({ dismissed: [] })} className="mt-4 text-[13px] text-s-ink-2 underline-offset-4 hover:text-s-ink hover:underline">
            Show {prefs.dismissed.length} dismissed suggestion{prefs.dismissed.length === 1 ? "" : "s"} again
          </button>
        )}
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- pieces

/** Pinned agents first, then the user's own, then built-ins; and saved prompts as one-click shortcuts. */
function AgentsAndShortcuts({ pinned, onPin, onPrompt, onManagePrompts }: { pinned: string[]; onPin: (id: string) => void; onPrompt: (text: string) => void; onManagePrompts: () => void }) {
  const agents = useAgents();
  const { prompts } = useSavedPrompts();
  if (agents.status === "loading") return <Rows n={3} />;
  const list =
    agents.status === "ready"
      ? (() => {
          const all = [...agents.custom, ...agents.builtins];
          const pins = pinned.map((id) => all.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => !!a);
          return [...pins, ...all.filter((a) => !pinned.includes(a.id))].slice(0, 4);
        })()
      : [];
  return (
    <>
      {agents.status === "error" ? (
        <p className="text-[13px] text-s-ink-3">Agents couldn’t load: {agents.message}</p>
      ) : (
        <ul className="-mx-1.5 flex flex-col">
          {list.map((a) => {
            const isPinned = pinned.includes(a.id);
            return (
              <li key={a.id} className="group flex items-center gap-1 rounded-xl transition hover:bg-s-hover">
                <Link href={`/agents/${a.id}`} className="flex min-w-0 flex-1 items-center gap-3 px-1.5 py-2">
                  <AgentAvatar agent={a} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium">{a.name}</span>
                    <span className="block truncate text-[12.5px] text-s-ink-3">
                      {a.kind === "custom" ? "Your agent · " : ""}
                      {a.description}
                    </span>
                  </span>
                </Link>
                <button
                  type="button"
                  onClick={() => onPin(a.id)}
                  aria-pressed={isPinned}
                  aria-label={isPinned ? `Unpin ${a.name}` : `Pin ${a.name} to the top`}
                  title={isPinned ? "Unpin" : "Pin to the top"}
                  className={cn(
                    iconButtonClass("sm"),
                    "mr-1 h-8 w-8 shrink-0",
                    isPinned ? "text-s-ink" : "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100",
                  )}
                >
                  {isPinned ? <PinOff /> : <Pin />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-3 border-t border-s-line pt-3">
        <div className="mb-1.5 flex items-center gap-2">
          <h3 className="text-[12px] font-medium text-s-ink-3">Saved prompts</h3>
          <button type="button" onClick={onManagePrompts} className="ml-auto text-[12px] text-s-ink-3 underline-offset-2 hover:text-s-ink hover:underline">
            {prompts.length ? "Manage" : "Add one"}
          </button>
        </div>
        {prompts.length === 0 ? (
          <p className="text-[12.5px] leading-relaxed text-s-ink-3">Save a prompt you use often (from a message’s menu, or here) to start it again in one click.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {prompts.slice(0, 4).map((p) => (
              <li key={p.id} className="min-w-0 max-w-full">
                <button
                  type="button"
                  onClick={() => onPrompt(p.text)}
                  title={p.text}
                  className="inline-flex h-8 max-w-[260px] items-center rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink"
                >
                  <span className="truncate">{p.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function Section({
  id,
  title,
  icon,
  onHide,
  action,
  footer,
  className,
  children,
}: {
  id: HomeSectionId;
  title: string;
  icon: ReactNode;
  onHide: (id: HomeSectionId) => void;
  action?: ReactNode;
  footer?: { href: string; label: string };
  className?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`home-${id}`} className={cn("glass flex min-w-0 flex-col rounded-[22px] p-4 sm:p-5", className)}>
      <div className="mb-3 flex min-h-8 items-center gap-2">
        <span className="text-s-ink-3 [&_svg]:h-4 [&_svg]:w-4" aria-hidden>
          {icon}
        </span>
        <h2 id={`home-${id}`} className="text-[14px] font-semibold tracking-[-0.005em]">
          {title}
        </h2>
        <div className="ml-auto flex items-center gap-0.5">
          {action}
          <Menu label={`${title} options`} align="end" width={200} buttonLabel={`${title} options`} buttonClassName={cn(iconButtonClass("sm"), "h-8 w-8")} button={<Ellipsis />}>
            <MenuItem icon={<EyeOff />} onClick={() => onHide(id)}>
              Hide this section
            </MenuItem>
          </Menu>
        </div>
      </div>
      <div className="min-w-0 flex-1">{children}</div>
      {footer && (
        <Link href={footer.href} className="mt-3 inline-flex w-fit items-center gap-1 text-[13px] text-s-ink-2 transition hover:text-s-ink">
          {footer.label} <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      )}
    </section>
  );
}

function ActionButton({ action, onAction, className, title, children }: { action: HomeAction; onAction: (a: HomeAction) => void; className: string; title?: string; children: ReactNode }) {
  if (action.kind === "link")
    return (
      <Link href={action.href} className={className} title={title}>
        {children}
      </Link>
    );
  return (
    <button type="button" onClick={() => onAction(action)} className={className} title={title}>
      {children}
    </button>
  );
}

function DiscoverCard({ item, onAction, onDismiss }: { item: DiscoverItem; onAction: (a: HomeAction) => void; onDismiss: () => void }) {
  return (
    <li className="group relative flex flex-col rounded-2xl border border-s-line p-4 transition hover:border-s-line-strong">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-s-accent-soft text-s-ink-2 [&_svg]:h-4 [&_svg]:w-4">{HOME_ICONS[item.icon]}</span>
      <h3 className="mt-3 pr-6 text-[14px] font-medium">{item.title}</h3>
      <p className="mt-1 flex-1 text-[13px] leading-snug text-s-ink-3">{item.text}</p>
      <ActionButton action={item.action} onAction={onAction} className="mt-3 inline-flex w-fit items-center gap-1 text-[13px] font-medium text-s-ink transition hover:opacity-80">
        {item.cta} <ArrowRight className="h-3.5 w-3.5" />
      </ActionButton>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={`Not interested: ${item.title}`}
        title="Not interested"
        className={cn(iconButtonClass("sm"), "absolute right-2 top-2 h-7 w-7 opacity-60 hover:opacity-100")}
      >
        <X />
      </button>
    </li>
  );
}

function NewProjectMenu() {
  const router = useRouter();
  return (
    <Menu label="New project" align="end" width={240} buttonLabel="New project" buttonClassName={cn(iconButtonClass("sm"), "h-8 w-8")} button={<Plus />}>
      <MenuItem icon={<Code2 />} hint="Software the agent can edit, run and test" onClick={() => router.push("/code?new=1")}>
        Code project
      </MenuItem>
      <MenuItem icon={<Globe />} hint="Describe a site; the agent builds and checks it" onClick={() => router.push("/code")}>
        Website
      </MenuItem>
      <MenuItem icon={<Flag />} hint="A goal turned into milestones and tasks" onClick={() => router.push("/missions")}>
        Mission
      </MenuItem>
    </Menu>
  );
}

type FocusItem = NonNullable<HomePrefs["focus"]>["items"][number];
const newId = () =>
  (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.random()}`)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .slice(0, 16)
    .padEnd(8, "0");

/** Today's priorities, written by the user (Orbis has no reminders service; nothing here is generated). */
function FocusList({ items, leftover, onChange }: { items: FocusItem[]; leftover: FocusItem[]; onChange: (items: FocusItem[]) => void }) {
  const [text, setText] = useState("");
  const full = items.length >= FOCUS_LIMIT;
  const add = () => {
    const t = text.trim();
    if (!t || full) return;
    onChange([...items, { id: newId(), text: t.slice(0, 200), done: false }]);
    setText("");
  };
  return (
    <div>
      <h3 className="mb-1.5 text-[12px] font-medium text-s-ink-3">Today’s priorities</h3>
      {items.length > 0 && (
        <ul className="mb-2 flex flex-col gap-0.5">
          {items.map((it) => (
            <li key={it.id} className="group -mx-1.5 flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-s-hover">
              <button
                type="button"
                role="checkbox"
                aria-checked={it.done}
                aria-label={`${it.done ? "Mark not done" : "Mark done"}: ${it.text}`}
                onClick={() => onChange(items.map((x) => (x.id === it.id ? { ...x, done: !x.done } : x)))}
                className={cn(
                  "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-md border transition",
                  it.done ? "border-transparent bg-s-accent text-s-accent-ink" : "border-s-line-strong hover:border-s-ink-3",
                )}
              >
                {it.done && <Check className="h-3 w-3" strokeWidth={3} />}
              </button>
              <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", it.done && "text-s-ink-3 line-through")}>{it.text}</span>
              <button
                type="button"
                onClick={() => onChange(items.filter((x) => x.id !== it.id))}
                aria-label={`Remove: ${it.text}`}
                className={cn(iconButtonClass("sm"), "h-6 w-6 opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100")}
              >
                <X />
              </button>
            </li>
          ))}
        </ul>
      )}
      {leftover.length > 0 && items.length === 0 && (
        <button
          type="button"
          onClick={() => onChange(leftover.slice(0, FOCUS_LIMIT).map((x) => ({ ...x, id: newId() })))}
          className="mb-2 text-[13px] text-s-ink-2 underline-offset-4 hover:text-s-ink hover:underline"
        >
          Carry over {leftover.length} unfinished from last time
        </button>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
        className="flex items-center gap-2"
      >
        <label htmlFor="home-focus" className="sr-only">
          Add a priority for today
        </label>
        <input
          id="home-focus"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={200}
          disabled={full}
          placeholder={full ? `Up to ${FOCUS_LIMIT} priorities` : items.length ? "Add another…" : "What matters most today?"}
          className="h-9 min-w-0 flex-1 rounded-xl border border-s-line bg-transparent px-3 text-[13.5px] outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong disabled:opacity-60"
        />
        <button type="submit" disabled={!text.trim() || full} aria-label="Add priority" className={cn(iconButtonClass("sm"), "h-9 w-9 border border-s-line disabled:opacity-40")}>
          <Plus />
        </button>
      </form>
    </div>
  );
}

type EventsState = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; events: DayEvent[] };

/** Today's calendar events, when Google Calendar is connected (the browser's local day). */
function useDayEvents(date: Date | null) {
  const [state, setState] = useState<EventsState>({ status: "idle" });
  const day = date ? localDay(date) : null;
  useEffect(() => {
    if (!day) return;
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const start = new Date(y, m - 1, d);
    const end = new Date(y, m - 1, d + 1);
    let alive = true;
    jsonFetch<{ state: string; events: DayEvent[] }>(`/api/home/day?timeMin=${encodeURIComponent(start.toISOString())}&timeMax=${encodeURIComponent(end.toISOString())}`)
      .then((r) => alive && setState({ status: "ready", events: r.events }))
      .catch((e: Error) => alive && setState({ status: "error", message: e.message }));
    return () => {
      alive = false;
    };
  }, [day]);
  return state;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function CalendarBlock({ signedIn, state, events }: { signedIn: boolean; state: HomeData["calendar"] | null; events: EventsState }) {
  if (state === null) return null;
  const note = (children: ReactNode) => <p className="mt-4 flex items-start gap-2 text-[12.5px] leading-snug text-s-ink-3">{children}</p>;
  if (!signedIn) return note(<>Sign in and connect Google Calendar to see today’s events here.</>);
  if (state === "unavailable") return note(<>Calendar events will show here once Google Calendar can be connected on this site (it isn’t set up yet).</>);
  if (state === "not_connected")
    return note(
      <>
        <CalendarDays className="mt-px h-3.5 w-3.5 shrink-0" />
        <span>
          <Link href="/connectors" className="text-s-ink underline-offset-4 hover:underline">
            Connect Google Calendar
          </Link>{" "}
          to see today’s events here.
        </span>
      </>,
    );
  if (state === "reauth")
    return note(
      <>
        Google Calendar needs reconnecting.{" "}
        <Link href="/connectors" className="text-s-ink underline-offset-4 hover:underline">
          Reconnect
        </Link>
      </>,
    );
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-[12px] font-medium text-s-ink-3">Calendar</h3>
      {events.status === "loading" || events.status === "idle" ? (
        <Rows n={2} />
      ) : events.status === "error" ? (
        <p className="text-[12.5px] text-s-ink-3">Today’s events couldn’t load: {events.message}</p>
      ) : events.events.length === 0 ? (
        <p className="text-[13px] text-s-ink-3">Nothing on your calendar today.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {events.events.map((e, i) => (
            <li key={`${e.start}:${i}`} className="flex items-baseline gap-3 text-[13.5px]">
              <span className="w-16 shrink-0 text-[12.5px] tabular-nums text-s-ink-3" suppressHydrationWarning>
                {e.allDay ? "All day" : timeOf(e.start)}
              </span>
              {e.url ? (
                <a href={e.url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:underline">
                  {e.title}
                </a>
              ) : (
                <span className="min-w-0 truncate">{e.title}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The one thing to resume: a project that needs the user, else the latest conversation. */
function pickResume(projects: HomeData["projects"] | null, conversations: HomeConversation[] | null): { href: string; title: string; detail: string; icon: ReactNode } | null {
  const waiting = projects?.find((p) => p.attention);
  if (waiting) return { href: waiting.href, title: waiting.name, detail: waiting.attention!, icon: waiting.kind === "code" ? <Code2 /> : <Flag /> };
  const c = conversations?.[0];
  if (c) return { href: `/chat?c=${c.id}`, title: c.title, detail: c.preview ?? "Your latest conversation", icon: <MessageSquare /> };
  return null;
}

function Rows({ n = 3 }: { n?: number }) {
  return (
    <div className="space-y-3 py-1" role="status" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="s-skeleton h-4" style={{ width: `${[78, 62, 86, 54][i % 4]}%` }} />
      ))}
    </div>
  );
}

function Empty({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 py-1 text-[13.5px] leading-relaxed text-s-ink-3">
      <p>{text}</p>
      {children && <div className="text-[13px]">{children}</div>}
    </div>
  );
}

function PartError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p className="flex flex-wrap items-center gap-2 py-1 text-[13px] text-s-ink-3">
      Couldn’t load {what}.
      <button type="button" onClick={onRetry} className="text-s-ink underline-offset-4 hover:underline">
        Try again
      </button>
    </p>
  );
}

function Pill({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex h-8 items-center rounded-full border border-s-line-strong px-3 text-[12.5px] text-s-ink transition hover:bg-s-hover">
      {children}
    </Link>
  );
}
