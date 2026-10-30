"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Loader2, Save, Sparkles, StopCircle } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader, useStudio } from "@/components/studio/frame";
import { Markdown } from "@/components/common/markdown";
import { postNdjson } from "@/hooks/use-ndjson";
import { analyzeUrl, passwordStrength } from "@/lib/workspaces/analyze";
import { BuilderPanel } from "@/components/workspaces/builder-panel";
import { findTool, findWorkspaceTemplate, WORKSPACES, type WorkspaceKey } from "@/lib/workspaces/catalog";
import { findPrompt } from "@/lib/workspaces/prompts";
import { cn } from "@/lib/utils";

function Back({ ws, to = "tools" }: { ws: WorkspaceKey; to?: "tools" | "templates" }) {
  const base = WORKSPACES[ws].base;
  return (
    <Link href={`${base}/${to}`} className="inline-flex h-9 items-center gap-1 rounded-xl pl-1.5 pr-2.5 text-[13.5px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink">
      <ChevronLeft className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">{to === "templates" ? "Templates" : "Tools"}</span>
    </Link>
  );
}

const primaryBtn = "inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50";
const quietBtn = "inline-flex h-10 items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[14px] font-medium transition hover:bg-s-hover active:scale-[0.98] disabled:opacity-50";

/** The shared streaming AI panel used by AI tools and templates: brief in, draft out, save/edit the result. */
function AiPanel({ ws, kind, title, lead, input, extra, backTo }: { ws: WorkspaceKey; kind: string; title: string; lead: string; input: { label: string; placeholder: string }; extra?: { key: string; label: string; placeholder: string }; backTo: "tools" | "templates" }) {
  const { user, integrations } = useApp();
  const { notify } = useStudio();
  const params = useSearchParams();
  const base = WORKSPACES[ws].base;
  const signedOut = integrations.supabase && !user;

  const [text, setText] = useState("");
  const [extraVal, setExtraVal] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [savedTitle, setSavedTitle] = useState(title);
  const abort = useRef<AbortController | null>(null);

  // Reopen a saved item (?item=id).
  const itemId = params.get("item");
  useEffect(() => {
    if (!itemId) return;
    let alive = true;
    fetch(`/api/workspaces/${ws}/items/${itemId}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error())))
      .then((j: { item: { title: string; data: Record<string, unknown> } }) => {
        if (!alive) return;
        setSavedId(itemId);
        setSavedTitle(j.item.title);
        setText(String(j.item.data.input ?? ""));
        setExtraVal(String(j.item.data.extra ?? ""));
        setOut(String(j.item.data.output ?? ""));
      })
      .catch(() => alive && setError("That saved item couldn't be loaded."));
    return () => {
      alive = false;
    };
  }, [itemId, ws]);

  const quick = useMemo(() => (kind === "phishing-check" && extraVal.trim() ? analyzeUrl(extraVal.trim()) : null), [kind, extraVal]);

  const run = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError(null);
    setOut("");
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      for await (const ev of postNdjson<{ type: string; text?: string; message?: string }>(`/api/workspaces/${ws}/generate`, { kind, input: text, extra: extraVal || undefined }, ctrl.signal)) {
        if (ev.type === "delta" && ev.text) setOut((o) => o + ev.text);
      }
    } catch (e) {
      if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : "The tool failed. Please try again.");
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  const save = async () => {
    const data = { input: text, extra: extraVal, output: out };
    try {
      if (savedId) {
        await fetch(`/api/workspaces/${ws}/items/${savedId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) });
        notify("Saved.");
      } else {
        const r = await fetch(`/api/workspaces/${ws}/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, title: savedTitle, data }) });
        if (!r.ok) throw new Error();
        const j = (await r.json()) as { item: { id: string } };
        setSavedId(j.item.id);
        notify("Saved to projects.");
      }
    } catch {
      setError("Couldn't save. Please try again.");
    }
  };

  return (
    <>
      <StudioHeader>
        <Back ws={ws} to={backTo} />
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[860px] px-4 pb-24 pt-3 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(26px,4vw,36px)] leading-[1.1] tracking-[-0.01em]">{title}</h1>
            <p className="mt-2 text-[14.5px] text-s-ink-2">{lead}</p>
          </div>
          <div className="s-in mt-6 space-y-3 [animation-delay:30ms]">
            <label className="block">
              <span className="mb-1 block text-[12.5px] font-medium text-s-ink-2">{input.label}</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder={input.placeholder} className="glass w-full rounded-xl p-3 text-[14px] leading-relaxed text-s-ink outline-none focus:border-s-line-strong" />
            </label>
            {extra && (
              <label className="block">
                <span className="mb-1 block text-[12.5px] font-medium text-s-ink-2">{extra.label}</span>
                <input value={extraVal} onChange={(e) => setExtraVal(e.target.value)} placeholder={extra.placeholder} className="glass h-10 w-full rounded-xl px-3 text-[14px] text-s-ink outline-none focus:border-s-line-strong" />
              </label>
            )}
            {quick && (
              <div className={cn("rounded-xl border p-3 text-[13px]", quick.risk >= 40 ? "border-s-danger/40 bg-s-danger/5" : "border-s-line bg-s-panel-2")}>
                <div className="mb-1 font-medium">Quick link check{quick.host ? ` · ${quick.host}` : ""} · risk {quick.risk}/100</div>
                <ul className="space-y-0.5 text-s-ink-2">
                  {quick.signals.slice(0, 5).map((s, i) => (
                    <li key={i}>• {s.message}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {busy ? (
                <button type="button" onClick={() => abort.current?.abort()} className={quietBtn}>
                  <StopCircle className="h-4 w-4" /> Stop
                </button>
              ) : (
                <button type="button" onClick={run} disabled={!text.trim() || signedOut} className={primaryBtn}>
                  <Sparkles className="h-4 w-4" /> {out ? "Regenerate" : "Generate"}
                </button>
              )}
              {out && !busy && (
                <button type="button" onClick={save} disabled={signedOut} className={quietBtn}>
                  <Save className="h-4 w-4" /> {savedId ? "Save changes" : "Save to projects"}
                </button>
              )}
              {savedId && (
                <Link href={`${base}/projects`} className="text-[13px] text-s-accent underline-offset-4 hover:underline">
                  In Projects
                </Link>
              )}
            </div>
            {signedOut && (
              <p className="text-[13px] text-s-ink-3">
                <Link href={`/login?next=${base}`} className="text-s-accent underline-offset-4 hover:underline">
                  Sign in
                </Link>{" "}
                to run AI tools and save your work.
              </p>
            )}
            {error && <p role="alert" className="text-[13px] text-s-danger">{error}</p>}
          </div>
          {(out || busy) && (
            <div className="s-in mt-6 rounded-[18px] border border-s-line bg-s-panel-2 p-5">
              {busy && !out && (
                <div className="flex items-center gap-2 text-[13.5px] text-s-ink-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Working…
                </div>
              )}
              {out && <Markdown text={out} />}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/** Password strength — computed entirely in the browser; the password is never sent anywhere. */
function PasswordPanel({ ws }: { ws: WorkspaceKey }) {
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const r = passwordStrength(pw);
  const colors = ["bg-s-danger", "bg-s-danger", "bg-amber-500", "bg-s-accent", "bg-emerald-500"];
  return (
    <>
      <StudioHeader>
        <Back ws={ws} />
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[680px] px-4 pb-24 pt-3 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(26px,4vw,36px)] tracking-[-0.01em]">Password strength analysis</h1>
            <p className="mt-2 text-[14.5px] text-s-ink-2">Checked on your device only. Nothing you type is sent to Orbis.</p>
          </div>
          <div className="s-in mt-6 [animation-delay:30ms]">
            <div className="relative">
              <input
                type={show ? "text" : "password"}
                value={pw}
                onChange={(e) => setPw(e.target.value)}
                placeholder="Type or paste a password"
                aria-label="Password to check"
                autoComplete="off"
                className="glass h-12 w-full rounded-xl pl-4 pr-20 text-[15px] text-s-ink outline-none focus:border-s-line-strong"
              />
              <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-s-ink-2 hover:bg-s-hover">
                {show ? "Hide" : "Show"}
              </button>
            </div>
            {pw && (
              <div className="mt-4">
                <div className="flex gap-1.5">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className={cn("h-1.5 flex-1 rounded-full", i <= r.score ? colors[r.score] : "bg-s-line")} />
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between text-[13px]">
                  <span className="font-medium capitalize">{r.label}</span>
                  <span className="text-s-ink-3">≈ {r.entropyBits} bits of entropy</span>
                </div>
                <ul className="mt-4 space-y-1.5 text-[13.5px] text-s-ink-2">
                  {r.suggestions.map((s, i) => (
                    <li key={i}>• {s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

/** Build a real site with the coding agent (website-generation tools). Creates a project and starts the agent. */
function WebsiteGenPanel({ ws, title, lead }: { ws: WorkspaceKey; title: string; lead: string }) {
  const { user, integrations } = useApp();
  const router = useRouter();
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signedOut = integrations.supabase && !user;

  const build = async () => {
    if (!brief.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await fetch("/api/code/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: brief.trim().slice(0, 60) || "Website", template: "website" }) });
      if (!made.ok) throw new Error((await made.json().catch(() => ({})))?.error?.message ?? "Couldn't create the project.");
      const pid = ((await made.json()) as { project: { id: string } }).project.id;
      const run = await fetch(`/api/code/projects/${pid}/agent`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request: brief.trim(), options: { modelId: "auto:coding", approvePlans: false, reviewEdits: false, commands: "safe", readOnly: false, background: true } }) });
      if (!run.ok) throw new Error((await run.json().catch(() => ({})))?.error?.message ?? "The build couldn't start.");
      router.push(`/code/${pid}?build=1`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <>
      <StudioHeader>
        <Back ws={ws} />
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-24 pt-3 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(26px,4vw,36px)] tracking-[-0.01em]">{title}</h1>
            <p className="mt-2 text-[14.5px] text-s-ink-2">{lead}</p>
          </div>
          <div className="s-in mt-6 space-y-3 [animation-delay:30ms]">
            <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={6} placeholder="Describe the site: who it's for, the pages and sections, the style…" className="glass w-full rounded-xl p-3 text-[14px] leading-relaxed text-s-ink outline-none focus:border-s-line-strong" />
            <button type="button" onClick={build} disabled={!brief.trim() || busy || signedOut} className={primaryBtn}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} {busy ? "Starting the build…" : "Build with AI"}
            </button>
            <p className="text-[12.5px] text-s-ink-3">This opens Orbis Code and the agent builds it live. A build uses your plan’s allowance.</p>
            {signedOut && (
              <p className="text-[13px] text-s-ink-3">
                <Link href={`/login?next=${WORKSPACES[ws].base}`} className="text-s-accent underline-offset-4 hover:underline">
                  Sign in
                </Link>{" "}
                to build and save websites.
              </p>
            )}
            {error && <p role="alert" className="text-[13px] text-s-danger">{error}</p>}
          </div>
        </div>
      </div>
    </>
  );
}

const WEBSITE_GEN = new Set(["generate", "landing", "store", "blog", "redesign"]);

/** Resolve a tool id to the right panel. */
export function ToolRunner({ ws, toolId }: { ws: WorkspaceKey; toolId: string }) {
  const tool = findTool(ws, toolId);
  if (!tool) return <Missing ws={ws} to="tools" />;
  if (tool.kind === "link") return <Redirect href={tool.href!} />;
  if (ws === "cyber" && toolId === "password-check") return <PasswordPanel ws={ws} />;
  if (ws === "web" && toolId === "builder") return <BuilderPanel ws={ws} />;
  if (ws === "web" && WEBSITE_GEN.has(toolId)) return <WebsiteGenPanel ws={ws} title={tool.name} lead={tool.description} />;
  const prompt = findPrompt(ws, toolId);
  if (!prompt) return <Missing ws={ws} to="tools" />;
  return <AiPanel ws={ws} kind={toolId} title={tool.name} lead={tool.description} input={prompt.input} extra={prompt.extra} backTo="tools" />;
}

/** A template opens the AI draft panel pre-set to draft that document. */
export function TemplateRunner({ ws, templateId }: { ws: WorkspaceKey; templateId: string }) {
  const tpl = findWorkspaceTemplate(ws, templateId);
  if (!tpl) return <Missing ws={ws} to="templates" />;
  const input =
    ws === "cyber"
      ? { label: "Brief", placeholder: "The context: scope, systems, findings, dates, who it's for…" }
      : { label: "Brief", placeholder: "The business, audience, pages and style you want…" };
  return <AiPanel ws={ws} kind={`template:${templateId}`} title={tpl.name} lead={tpl.description} input={input} backTo="templates" />;
}

function Redirect({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(href);
  }, [href, router]);
  return null;
}

function Missing({ ws, to }: { ws: WorkspaceKey; to: "tools" | "templates" }) {
  return (
    <>
      <StudioHeader>
        <Back ws={ws} to={to} />
      </StudioHeader>
      <div className="mx-auto mt-[14vh] max-w-sm px-4 text-center">
        <h1 className="text-[18px] font-semibold">Not found</h1>
        <p className="mt-1.5 text-[14px] text-s-ink-2">This item doesn’t exist in {WORKSPACES[ws].label}.</p>
        <Link href={`${WORKSPACES[ws].base}/${to}`} className="mt-5 inline-block rounded-xl border border-s-line-strong px-4 py-2 text-[13.5px] font-medium hover:bg-s-hover">
          Back
        </Link>
      </div>
    </>
  );
}
