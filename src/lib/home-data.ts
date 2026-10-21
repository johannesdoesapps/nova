import "server-only";
import type { AuthContext } from "@/lib/auth";
import { missingSetup } from "@/lib/connectors/oauth";
import { getConnection, usable } from "@/lib/connectors/runtime";
import { connector } from "@/lib/connectors/registry";
import { listConversations } from "@/lib/db";
import { listMissions } from "@/lib/db/missions";
import { reportError } from "@/lib/observability";
import { listProjects as listCodeProjects } from "@/lib/code/server";
import { readPrefs, type HomeConversation, type HomeData, type HomeProject, type HomeTask } from "./home";

type Authed = Extract<AuthContext, { mode: "authenticated" }>;

/** Plain text from the start of a message (markdown marks and extra space removed). */
export function previewOf(content: string, max = 140): string {
  const t = content
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/[#>*_`~|]+/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const WAITING: Record<string, string> = {
  awaiting_approval: "the agent is waiting for your approval",
  needs_input: "the agent is waiting for you",
  planning: "the agent is working",
  running: "the agent is working",
};

/** One part of the home; a part that fails is logged and left empty, so the rest still shows. */
async function part<T>(name: string, fallback: T, fn: () => Promise<T>, errors: string[]): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    reportError(err, { where: `home.${name}` });
    errors.push(name);
    return fallback;
  }
}

/** Everything the signed-in home shows, from the user's own records (row-level security keeps it to them). */
export async function loadHome(auth: Authed): Promise<HomeData & { errors: string[] }> {
  const db = auth.supabase;
  const uid = auth.user.id;
  const errors: string[] = [];

  const [conversations, code, missions, prefs, calendar] = await Promise.all([
    part<HomeConversation[]>(
      "conversations",
      [],
      async () => {
        const rows = await listConversations(db, uid, 6);
        if (!rows.length) return [];
        const { data } = await db
          .from("messages")
          .select("conversation_id,role,content,created_at")
          .in(
            "conversation_id",
            rows.map((r) => r.id),
          )
          .order("created_at", { ascending: false })
          .limit(60);
        // The newest message per chat; a question and its reply can share a timestamp, so the reply wins a tie.
        const latest = new Map<string, { content: string; created_at: string; role: string }>();
        for (const m of (data ?? []) as { conversation_id: string; role: string; content: string; created_at: string }[]) {
          const seen = latest.get(m.conversation_id);
          if (!seen || (m.created_at === seen.created_at && m.role === "assistant" && seen.role !== "assistant")) latest.set(m.conversation_id, m);
        }
        return rows.map((r) => ({ id: r.id, title: r.title, mode: r.mode, updatedAt: r.updated_at, preview: latest.has(r.id) ? previewOf(latest.get(r.id)!.content) : null }));
      },
      errors,
    ),
    part(
      "code",
      { projects: [] as HomeProject[] },
      async () => {
        const list = (await listCodeProjects(auth)).slice(0, 12);
        if (!list.length) return { projects: [] };
        const { data: runs } = await db
          .from("code_agent_runs")
          .select("project_id,status,request,updated_at")
          .in(
            "project_id",
            list.map((p) => p.id),
          )
          .in("status", Object.keys(WAITING))
          .order("updated_at", { ascending: false })
          .limit(20);
        const open = new Map<string, { status: string; request: string }>();
        for (const r of (runs ?? []) as { project_id: string; status: string; request: string }[]) if (!open.has(r.project_id)) open.set(r.project_id, r);
        const kind: Record<string, string> = { website: "Website", node: "Node.js", python: "Python", blank: "Project", github: "From GitHub" };
        return {
          projects: list.map((p) => {
            const run = open.get(p.id);
            return {
              kind: "code" as const,
              id: p.id,
              name: p.name,
              updatedAt: p.updatedAt,
              href: `/code/${p.id}`,
              detail: `${p.sourceRepo ?? kind[p.template] ?? "Code"} project`,
              attention: run ? `Code: ${WAITING[run.status]}` : null,
            };
          }),
        };
      },
      errors,
    ),
    part(
      "missions",
      { projects: [] as HomeProject[], tasks: [] as HomeTask[] },
      async () => {
        const list = (await listMissions(db, uid)).filter((m) => m.status !== "archived").slice(0, 20);
        if (!list.length) return { projects: [], tasks: [] };
        const names = new Map(list.map((m) => [m.id, m.name]));
        const { data } = await db
          .from("project_tasks")
          .select("id,title,status,priority,project_id,updated_at")
          .eq("user_id", uid)
          .in("status", ["in_progress", "pending", "blocked"])
          .in("project_id", [...names.keys()])
          .order("updated_at", { ascending: false })
          .limit(60);
        const rank = (t: { status: string; priority: string }) => (t.status === "in_progress" ? 0 : t.priority === "high" ? 1 : t.status === "blocked" ? 2 : 3);
        const tasks = ((data ?? []) as { id: string; title: string; status: HomeTask["status"]; priority: HomeTask["priority"]; project_id: string }[])
          .sort((a, b) => rank(a) - rank(b))
          .slice(0, 6)
          .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, project: names.get(t.project_id) ?? "", href: `/missions/${t.project_id}` }));
        const projects = list.map((m) => {
          const c = m.counts;
          const total = c.pending + c.in_progress + c.completed + c.blocked;
          return {
            kind: "mission" as const,
            id: m.id,
            name: m.name,
            updatedAt: m.updated_at,
            href: `/missions/${m.id}`,
            detail: total ? `Mission · ${c.completed} of ${total} tasks done` : m.status === "completed" ? "Mission · completed" : "Mission · no tasks yet",
            attention: c.in_progress ? `${c.in_progress} task${c.in_progress === 1 ? "" : "s"} in progress` : null,
          };
        });
        return { projects, tasks };
      },
      errors,
    ),
    part(
      "prefs",
      readPrefs(null),
      async () => {
        const { data } = await db.from("profiles").select("preferences").eq("id", uid).maybeSingle();
        return readPrefs((data?.preferences as { home?: unknown } | null)?.home);
      },
      errors,
    ),
    part<HomeData["calendar"]>("calendar", "unavailable", () => calendarState(auth), errors),
  ]);

  const projects = [...code.projects, ...missions.projects].sort((a, b) => Number(!!b.attention) - Number(!!a.attention) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return { signedIn: true, conversations, projects: projects.slice(0, 12), tasks: missions.tasks, prefs, calendar, errors };
}

/** Whether Google Calendar can show today's events: set up on this site, connected, or needing reconnecting. */
export async function calendarState(auth: Authed): Promise<HomeData["calendar"]> {
  const c = connector("google_calendar");
  if (!c || missingSetup(c).length) return "unavailable";
  const row = await getConnection(auth, "google_calendar");
  if (usable(c, row)) return "connected";
  return row?.status === "reauth_required" ? "reauth" : "not_connected";
}
