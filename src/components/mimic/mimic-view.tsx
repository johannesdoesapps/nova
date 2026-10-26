"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, CircleAlert, Hand, Inbox, Loader2, MousePointerClick, OctagonX, Play, Plug, Upload } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { Segmented, Switch } from "@/components/studio/ui";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { Overview, RunView, WorkflowView } from "@/lib/mimic/server";
import { CATEGORIES, MODE_LABEL, TRIGGER_LABEL, type Category } from "@/lib/mimic/types";
import { cn } from "@/lib/utils";
import { fmtTime, RunCard, StatusPill } from "./run-card";
import { TeachMimic } from "./teach";
import { WF_STATUS, WorkflowPanel } from "./workflow-panel";

const TABS = ["dashboard", "teach", "automations", "attention", "accounting", "activity", "rules", "integrations", "settings"] as const;
type Tab = (typeof TABS)[number];
const WAITING = ["needs_approval", "needs_attention", "proposal", "failed"];

const card = "glass rounded-[22px] p-5";

export function MimicView() {
  const { user, integrations } = useApp();
  const router = useRouter();
  const params = useSearchParams();
  const fromUrl = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(fromUrl ?? "") ? (fromUrl as Tab) : "dashboard";
  const openId = params.get("w");
  const go = useCallback(
    (t: Tab, w?: string) => {
      const q = new URLSearchParams();
      if (t !== "dashboard") q.set("tab", t);
      if (w) q.set("w", w);
      router.replace(`/mimic${q.size ? `?${q}` : ""}`, { scroll: false });
    },
    [router],
  );
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const signedOut = integrations.supabase ? !user : true;
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (signedOut) return;
    let alive = true;
    jsonFetch<Overview>("/api/mimic")
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [version, signedOut]);

  const header = (
    <StudioHeader>
      <span className="text-[14px] font-medium">Mimic</span>
    </StudioHeader>
  );

  if (signedOut)
    return (
      <>
        {header}
        <div className="grid flex-1 place-items-center px-6 text-center">
          <div className="max-w-md">
            <MousePointerClick className="mx-auto h-8 w-8 text-s-ink-3" />
            <h1 className="mt-4 font-serif text-[34px] leading-tight">Mimic</h1>
            <p className="mt-2 text-[15px] text-s-ink-2">Show it once. It learns. It does it for you.{integrations.supabase ? "" : " Accounts aren't set up on this site yet."}</p>
            {integrations.supabase && (
              <Link href="/login?next=/mimic" className="mt-5 inline-flex h-10 items-center rounded-full bg-s-accent px-5 text-[14px] font-medium text-s-accent-ink">
                Sign in to start
              </Link>
            )}
          </div>
        </div>
      </>
    );

  const waiting = data?.runs.filter((r) => !r.dryRun && WAITING.includes(r.status)) ?? [];
  const wfName = (id: string) => data?.workflows.find((w) => w.id === id)?.name;
  const openWf = data?.workflows.find((w) => w.id === openId) ?? null;
  const upsertRun = (r: RunView) => setData((d) => (d ? { ...d, runs: [r, ...d.runs.filter((x) => x.id !== r.id)] } : d));

  return (
    <>
      {header}
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1180px] px-4 pb-24 pt-2 sm:px-8">
          <div className="s-in flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
            <div>
              <h1 className="font-serif text-[clamp(34px,5vw,46px)] leading-[1.05] tracking-[-0.01em]">Mimic</h1>
              <p className="mt-2 max-w-2xl text-[15.5px] text-s-ink-2">Show it once. It learns. It does it for you. Teach Mimic how you process a supplier invoice; it turns your demonstration into a checked, reusable automation that asks before it acts.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {data && <EmergencyStop stopped={data.settings.stopped} onChange={(s) => setData({ ...data, settings: s })} />}
              <button type="button" onClick={() => go("teach")} className="inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-4 text-[14px] font-semibold uppercase tracking-[0.04em] text-s-accent-ink shadow-[0_8px_24px_-12px_var(--s-accent)] transition hover:-translate-y-px hover:brightness-110">
                <MousePointerClick className="h-4 w-4" /> Teach Mimic
              </button>
            </div>
          </div>

          {data?.settings.stopped && (
            <div role="alert" className="mt-5 flex items-center gap-3 rounded-2xl border border-rose-500/40 bg-rose-500/8 px-4 py-3 text-[14px]">
              <OctagonX className="h-4 w-4 text-rose-600" /> The emergency stop is on. No automation will read, check or create anything until you turn it off. Test runs still work.
            </div>
          )}
          {error && (
            <div role="alert" className="mt-5 flex items-center gap-3 s-card rounded-2xl px-4 py-3 text-[14px]">
              <CircleAlert className="h-4 w-4 text-s-danger" /> <span className="flex-1">{error}</span>
              <button type="button" onClick={reload} className="rounded-xl border border-s-line-strong px-3 py-1.5 text-[13px] hover:bg-s-hover">
                Try again
              </button>
            </div>
          )}

          <div className="mt-7 overflow-x-auto pb-1">
            <Segmented
              label="Mimic sections"
              value={tab}
              onChange={(t) => go(t)}
              options={[
                { value: "dashboard", label: "Dashboard" },
                { value: "teach", label: "Teach Mimic" },
                { value: "automations", label: "My automations" },
                { value: "attention", label: `Needs my attention${waiting.length ? ` (${waiting.length})` : ""}` },
                { value: "accounting", label: "Accounting" },
                { value: "activity", label: "Activity" },
                { value: "rules", label: "Business rules" },
                { value: "integrations", label: "Integrations" },
                { value: "settings", label: "Settings" },
              ]}
            />
          </div>

          {!data && !error && (
            <div className="mt-10 flex items-center gap-2 text-[14px] text-s-ink-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading Mimic…
            </div>
          )}

          {data && (
            <div className="mt-6">
              {tab === "dashboard" && <Dashboard data={data} waiting={waiting} go={go} wfName={wfName} />}
              {tab === "teach" && (
                <TeachMimic
                  samples={data.samples}
                  ledger={data.ledger}
                  onCreated={(w) => {
                    setData({ ...data, workflows: [w, ...data.workflows] });
                    go("automations", w.id);
                  }}
                />
              )}
              {tab === "automations" &&
                (openWf ? (
                  <WorkflowPanel
                    workflow={openWf}
                    data={data}
                    onBack={() => go("automations")}
                    onChanged={(w) => {
                      if (!w) {
                        setData({ ...data, workflows: data.workflows.filter((x) => x.id !== openWf.id), runs: data.runs.filter((r) => r.workflowId !== openWf.id) });
                        go("automations");
                      } else setData({ ...data, workflows: data.workflows.map((x) => (x.id === w.id ? w : x)) });
                    }}
                    onRun={(r) => {
                      upsertRun(r);
                      reload();
                    }}
                  />
                ) : (
                  <Automations workflows={data.workflows} runs={data.runs} open={(id) => go("automations", id)} teach={() => go("teach")} />
                ))}
              {tab === "attention" && <Attention runs={waiting} wfName={wfName} onChanged={(r) => (upsertRun(r), reload())} />}
              {tab === "accounting" && <Accounting data={data} onAdded={reload} />}
              {tab === "activity" && <Activity data={data} wfName={wfName} />}
              {tab === "rules" && <Rules rules={data.rules} onChanged={reload} />}
              {tab === "integrations" && <Integrations />}
              {tab === "settings" && <SettingsPanel data={data} onChange={(s) => setData({ ...data, settings: s })} onDeleted={reload} />}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function EmergencyStop({ stopped, onChange }: { stopped: boolean; onChange: (s: Overview["settings"]) => void }) {
  const [busy, setBusy] = useState(false);
  const flip = async () => {
    setBusy(true);
    try {
      const r = await jsonFetch<{ settings: Overview["settings"] }>("/api/mimic/settings", { method: "PATCH", body: JSON.stringify({ stopped: !stopped }) });
      onChange(r.settings);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={flip}
      disabled={busy}
      className={cn("inline-flex h-10 items-center gap-2 rounded-xl border px-4 text-[14px] font-medium transition", stopped ? "border-s-line-strong hover:bg-s-hover" : "border-rose-500/50 text-rose-700 hover:bg-rose-500/10 dark:text-rose-300")}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : stopped ? <Play className="h-4 w-4" /> : <OctagonX className="h-4 w-4" />}
      {stopped ? "Resume automations" : "Emergency stop"}
    </button>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={card}>
      <p className="text-[12.5px] text-s-ink-2">{label}</p>
      <p className="mt-1 font-serif text-[30px] leading-none">{value}</p>
      {note && <p className="mt-2 text-[12px] text-s-ink-3">{note}</p>}
    </div>
  );
}

function Dashboard({ data, waiting, go, wfName }: { data: Overview; waiting: RunView[]; go: (t: Tab, w?: string) => void; wfName: (id: string) => string | undefined }) {
  const s = data.stats;
  if (!data.workflows.length)
    return (
      <section className={cn(card, "p-8 text-center")}>
        <MousePointerClick className="mx-auto h-8 w-8 text-s-ink-3" />
        <h2 className="mt-3 text-[20px] font-semibold">Teach Mimic its first task</h2>
        <p className="mx-auto mt-2 max-w-lg text-[14.5px] text-s-ink-2">
          Process one supplier invoice on the practice desk while Mimic watches. It learns which details go where, adds the safety checks, and asks about anything one demonstration can&apos;t settle. Then test it on other invoices.
        </p>
        <button type="button" onClick={() => go("teach")} className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-s-accent px-5 text-[14px] font-semibold uppercase tracking-[0.04em] text-s-accent-ink">
          <MousePointerClick className="h-4 w-4" /> Teach Mimic
        </button>
      </section>
    );
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Drafts in Demo Books" value={String(s.drafts)} />
        <Stat label="Runs (not counting tests)" value={String(s.runs)} note={s.runs ? `${s.completed} done · ${s.failed} failed` : undefined} />
        <Stat label="Waiting for you" value={String(s.needsYou)} />
        <Stat label="Time saved (estimate)" value={s.savedMinutes === null ? "—" : `${s.savedMinutes} min`} note={s.savedBasis} />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className={card} aria-labelledby="dash-attn">
          <div className="flex items-center justify-between">
            <h2 id="dash-attn" className="text-[15px] font-semibold">
              Needs my attention
            </h2>
            {waiting.length > 0 && (
              <button type="button" onClick={() => go("attention")} className="text-[13px] text-s-ink-2 hover:text-s-ink">
                See all
              </button>
            )}
          </div>
          {waiting.length ? (
            <ul className="mt-3 space-y-2">
              {waiting.slice(0, 5).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-[13.5px]">
                  <span className="truncate">{r.result?.proposed ? `${r.result.proposed.supplier} · ${r.result.proposed.invoiceNumber}` : (r.documentName ?? "Invoice")}</span>
                  <StatusPill status={r.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-[13.5px] text-s-ink-2">Nothing is waiting for you.</p>
          )}
        </section>
        <section className={card} aria-labelledby="dash-autos">
          <h2 id="dash-autos" className="text-[15px] font-semibold">
            My automations
          </h2>
          <ul className="mt-3 space-y-2">
            {data.workflows.slice(0, 5).map((w) => (
              <li key={w.id}>
                <button type="button" onClick={() => go("automations", w.id)} className="flex w-full items-center justify-between gap-2 rounded-xl px-2 py-1.5 text-left text-[13.5px] hover:bg-s-hover">
                  <span className="truncate">{w.name}</span>
                  <span className={cn("rounded-full px-2 py-0.5 text-[11.5px]", WF_STATUS[w.status].tone)}>{WF_STATUS[w.status].label}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <section className={card} aria-labelledby="dash-recent">
        <h2 id="dash-recent" className="text-[15px] font-semibold">
          Recent activity
        </h2>
        <EventList events={data.events.slice(0, 8)} wfName={wfName} />
      </section>
    </div>
  );
}

function Automations({ workflows, runs, open, teach }: { workflows: WorkflowView[]; runs: RunView[]; open: (id: string) => void; teach: () => void }) {
  if (!workflows.length)
    return (
      <div className="rounded-[22px] border border-dashed border-s-line-strong px-6 py-10 text-center text-[14px] text-s-ink-2">
        No automations yet.{" "}
        <button type="button" onClick={teach} className="font-medium text-s-ink underline underline-offset-2">
          Teach Mimic one
        </button>
        .
      </div>
    );
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {workflows.map((w) => {
        const mine = runs.filter((r) => r.workflowId === w.id && !r.dryRun);
        const last = mine[0];
        return (
          <article key={w.id} className={cn(card, "flex flex-col")}>
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-[16px] font-semibold">{w.name}</h3>
              <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[12px] font-medium", WF_STATUS[w.status].tone)}>{WF_STATUS[w.status].label}</span>
            </div>
            <p className="mt-1 text-[13px] text-s-ink-2">
              {MODE_LABEL[w.mode]} · {TRIGGER_LABEL[w.definition.trigger]}
            </p>
            <p className="mt-2 text-[12.5px] text-s-ink-3">
              {mine.length} run{mine.length === 1 ? "" : "s"}
              {last ? ` · last ${fmtTime(last.createdAt)}` : ""}
              {w.questions.some((q) => q.answer === null) ? " · questions to answer" : ""}
            </p>
            <div className="mt-auto pt-4">
              <button type="button" onClick={() => open(w.id)} className="h-9 w-full rounded-xl border border-s-line-strong text-[13.5px] font-medium hover:bg-s-hover">
                Review, test and run
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function Attention({ runs, wfName, onChanged }: { runs: RunView[]; wfName: (id: string) => string | undefined; onChanged: (r: RunView) => void }) {
  if (!runs.length)
    return (
      <div className="rounded-[22px] border border-dashed border-s-line-strong px-6 py-10 text-center text-[14px] text-s-ink-2">
        <Hand className="mx-auto mb-2 h-6 w-6 text-s-ink-3" />
        Nothing needs you. Approvals, missing details, uncertain categories and failures appear here.
      </div>
    );
  return (
    <div className="space-y-4">
      {runs.map((r) => (
        <RunCard key={r.id} run={r} workflowName={wfName(r.workflowId)} onChanged={onChanged} defaultOpen={runs.length === 1} />
      ))}
    </div>
  );
}

function Accounting({ data, onAdded }: { data: Overview; onAdded: () => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const add = async (source: "paste" | "upload", n = name, t = text) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await jsonFetch<{ runs: RunView[] }>("/api/mimic/documents", { method: "POST", body: JSON.stringify({ name: n.trim() || "Pasted invoice", text: t, source }) });
      setMsg(r.runs.length ? `Added. ${r.runs.length} automation${r.runs.length === 1 ? "" : "s"} ran on it: see Needs my attention or Activity.` : "Added to the inbox. No automation is set to run on new invoices; run one from My automations.");
      setName("");
      setText("");
      onAdded();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 60_000) return setMsg("That file is over 60 KB. Mimic reads text invoices (.txt) for now.");
    await add("upload", f.name, await f.text());
  };
  const total = useMemo(() => {
    const by = new Map<string, number>();
    for (const e of data.ledger) by.set(e.currency, (by.get(e.currency) ?? 0) + e.total);
    return [...by.entries()].map(([c, v]) => `${c} ${v.toFixed(2)}`).join(" · ");
  }, [data.ledger]);
  return (
    <div className="space-y-5">
      <section className={card} aria-labelledby="inbox-title">
        <h2 id="inbox-title" className="flex items-center gap-2 text-[15px] font-semibold">
          <Inbox className="h-4 w-4" /> Invoice inbox
        </h2>
        <p className="mt-1 text-[13px] text-s-ink-2">Paste an invoice&apos;s text or upload a .txt file. Automations set to &ldquo;When I add an invoice&rdquo; run on it straight away. PDF and image invoices aren&apos;t read yet.</p>
        <div className="mt-3 grid gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (e.g. Paper & Co. October)" className="h-9 rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px]" />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} placeholder="Paste the invoice text here" className="rounded-xl border border-s-line-strong bg-transparent px-3 py-2 font-mono text-[12.5px]" />
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => add("paste")} disabled={busy || text.trim().length < 20} className="inline-flex h-9 items-center gap-2 rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Inbox className="h-4 w-4" />} Add to inbox
            </button>
            <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-xl border border-s-line-strong px-4 text-[13.5px] hover:bg-s-hover">
              <Upload className="h-4 w-4" /> Upload .txt
              <input type="file" accept=".txt,text/plain" className="sr-only" onChange={(e) => upload(e.target.files?.[0])} />
            </label>
          </div>
          {msg && <p className="text-[13px] text-s-ink-2">{msg}</p>}
        </div>
        {data.documents.length > 0 && <p className="mt-3 text-[12.5px] text-s-ink-3">In the inbox: {data.documents.map((d) => d.name).join(", ")}</p>}
      </section>

      <section className={card} aria-labelledby="books-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="books-title" className="flex items-center gap-2 text-[15px] font-semibold">
            <BookOpen className="h-4 w-4" /> Demo Books · draft transactions
          </h2>
          {total && <span className="text-[12.5px] text-s-ink-2">Total of drafts: {total}</span>}
        </div>
        <p className="mt-1 text-[12.5px] text-s-ink-3">Demo Books is Mimic&apos;s built-in practice ledger, not your accounting system. Entries are drafts; nothing is posted, paid or filed.</p>
        {data.ledger.length ? (
          <div className="mt-3 overflow-x-auto" tabIndex={0} aria-label="Demo Books drafts">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="text-[12px] text-s-ink-3">
                <tr>
                  <th className="py-2 pr-3 font-normal">Supplier</th>
                  <th className="py-2 pr-3 font-normal">Invoice</th>
                  <th className="py-2 pr-3 font-normal">Date</th>
                  <th className="py-2 pr-3 font-normal">Due</th>
                  <th className="py-2 pr-3 text-right font-normal">Total</th>
                  <th className="py-2 pr-3 font-normal">Category</th>
                  <th className="py-2 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((e) => (
                  <tr key={e.id} className="border-t border-s-line">
                    <td className="py-2 pr-3">{e.supplier}</td>
                    <td className="py-2 pr-3">{e.invoiceNumber}</td>
                    <td className="py-2 pr-3">{e.invoiceDate}</td>
                    <td className="py-2 pr-3">{e.dueDate ?? "—"}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {e.currency} {e.total.toFixed(2)}
                    </td>
                    <td className="py-2 pr-3">{e.category}</td>
                    <td className="py-2">Draft</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 text-[13.5px] text-s-ink-2">No drafts yet. They appear when an automation runs (not when you test).</p>
        )}
      </section>

      <section className={card} aria-labelledby="next-title">
        <h2 id="next-title" className="text-[15px] font-semibold">
          Not built yet
        </h2>
        <p className="mt-1 text-[13px] text-s-ink-2">Bank reconciliation, payment reminders and monthly reports are planned. They need a real accounting or bank connection, which Mimic doesn&apos;t have yet.</p>
      </section>
    </div>
  );
}

function EventList({ events, wfName }: { events: Overview["events"]; wfName: (id: string) => string | undefined }) {
  if (!events.length) return <p className="mt-3 text-[13.5px] text-s-ink-2">Nothing yet.</p>;
  return (
    <ul className="mt-3 divide-y divide-s-line">
      {events.map((e) => (
        <li key={e.id} className="flex gap-3 py-2 text-[13.5px]">
          <span className="w-[108px] shrink-0 text-[12px] text-s-ink-3">{fmtTime(e.createdAt)}</span>
          <span className="w-[80px] shrink-0 text-[12px] capitalize text-s-ink-3">{e.kind}</span>
          <span className="min-w-0" title={e.workflowId ? wfName(e.workflowId) : undefined}>
            {e.summary}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Activity({ data, wfName }: { data: Overview; wfName: (id: string) => string | undefined }) {
  const [q, setQ] = useState("");
  const [view, setView] = useState<"log" | "runs">("log");
  const needle = q.trim().toLowerCase();
  const events = data.events.filter((e) => !needle || e.summary.toLowerCase().includes(needle) || e.kind.includes(needle));
  const runs = data.runs.filter((r) => !needle || JSON.stringify([r.documentName, r.status, r.result?.proposed]).toLowerCase().includes(needle));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Activity view"
          value={view}
          onChange={setView}
          options={[
            { value: "log", label: "Audit log" },
            { value: "runs", label: "Runs" },
          ]}
        />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search activity" className="h-9 w-full max-w-xs rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px]" />
      </div>
      {view === "log" ? (
        <section className={card}>
          <p className="text-[12.5px] text-s-ink-3">Every proposal, approval, completed and failed action, rule and setting change. Entries can&apos;t be edited.</p>
          <EventList events={events} wfName={wfName} />
        </section>
      ) : runs.length ? (
        runs.map((r) => <RunCard key={r.id} run={r} workflowName={wfName(r.workflowId)} />)
      ) : (
        <p className="text-[13.5px] text-s-ink-2">No runs yet.</p>
      )}
    </div>
  );
}

function Rules({ rules, onChanged }: { rules: Overview["rules"]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const patch = async (id: string, body: { category?: Category; remove?: boolean }) => {
    setBusy(id);
    setError(null);
    try {
      await jsonFetch(`/api/mimic/rules/${id}`, { method: "PATCH", body: JSON.stringify(body) });
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const active = rules.filter((r) => r.status === "active");
  const removed = rules.filter((r) => r.status === "removed");
  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-[13.5px] text-s-ink-2">Rules Mimic uses, each one approved by you. A correction becomes a rule only when you choose &ldquo;Always for this supplier&rdquo;. Mimic never turns its own guesses into rules.</p>
      {error && (
        <p role="alert" className="text-[13.5px] text-s-danger">
          {error}
        </p>
      )}
      {active.length ? (
        <div className="space-y-3">
          {active.map((r) => (
            <article key={r.id} className={card}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-[12.5px] text-s-ink-3">Invoices from</p>
                  <h3 className="text-[15.5px] font-semibold">{r.supplier}</h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[12.5px] text-s-ink-2">
                    <span className="sr-only">Category for {r.supplier}</span>
                    <select value={r.category} disabled={busy === r.id} onChange={(e) => patch(r.id, { category: e.target.value as Category })} className="h-9 rounded-xl border border-s-line-strong bg-transparent px-2 text-[13.5px] text-s-ink">
                      {CATEGORIES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <button type="button" onClick={() => patch(r.id, { remove: true })} disabled={busy === r.id} className="h-9 rounded-xl border border-s-line-strong px-3 text-[13px] hover:bg-s-hover">
                    Remove
                  </button>
                </div>
              </div>
              <details className="mt-3 text-[12.5px] text-s-ink-2">
                <summary className="cursor-pointer">History ({r.history.length})</summary>
                <ul className="mt-2 space-y-1">
                  {r.history.map((h, i) => (
                    <li key={i}>
                      {fmtTime(h.at)} · {h.action}: {h.detail}
                    </li>
                  ))}
                </ul>
              </details>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-[22px] border border-dashed border-s-line-strong px-6 py-10 text-center text-[14px] text-s-ink-2">No rules yet. They&apos;re added when you answer &ldquo;always&rdquo; to a category question.</div>
      )}
      {removed.length > 0 && <p className="text-[12.5px] text-s-ink-3">Removed rules (kept for the record): {removed.map((r) => r.supplier).join(", ")}</p>}
    </div>
  );
}

function Integrations() {
  const rows = [
    { name: "Demo Books", status: "Connected", note: "Built-in practice ledger. Mimic creates draft transactions only.", ok: true },
    { name: "Invoice inbox (paste or .txt upload)", status: "Available", note: "Text invoices. PDF and image reading (OCR) isn't built yet.", ok: true },
    { name: "AI reading", status: "Optional", note: "When labels aren't enough, an AI model reads the missing details; anything not found word-for-word in the invoice is discarded. Turn it off in Settings.", ok: true },
    { name: "Gmail or Outlook inbox", status: "Not yet", note: "Orbis can read these through Connectors, but Mimic can't watch an inbox for new invoices yet.", ok: false },
    { name: "Accounting software (e.g. Xero, QuickBooks, Bexio)", status: "Not yet", note: "No connector exists. Mimic won't pretend to write to one.", ok: false },
    { name: "Watching your whole computer or browser", status: "Not available", note: "Orbis is a web app and can't observe other apps. Mimic learns from the practice desk instead.", ok: false },
  ];
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <article key={r.name} className={cn(card, "flex flex-wrap items-start justify-between gap-3")}>
          <div className="flex min-w-0 gap-3">
            <Plug className={cn("mt-0.5 h-4 w-4 shrink-0", r.ok ? "text-emerald-600" : "text-s-ink-3")} />
            <div>
              <h3 className="text-[14.5px] font-semibold">{r.name}</h3>
              <p className="text-[13px] text-s-ink-2">{r.note}</p>
            </div>
          </div>
          <span className={cn("rounded-full px-2.5 py-0.5 text-[12px]", r.ok ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300" : "bg-s-hover text-s-ink-2")}>{r.status}</span>
        </article>
      ))}
      <p className="text-[12.5px] text-s-ink-3">
        Other apps live on{" "}
        <Link href="/connectors" className="underline underline-offset-2">
          Connectors
        </Link>
        .
      </p>
    </div>
  );
}

function SettingsPanel({ data, onChange, onDeleted }: { data: Overview; onChange: (s: Overview["settings"]) => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const set = async (body: Partial<Overview["settings"]>) => {
    setBusy(true);
    try {
      const r = await jsonFetch<{ settings: Overview["settings"] }>("/api/mimic/settings", { method: "PATCH", body: JSON.stringify(body) });
      onChange(r.settings);
    } finally {
      setBusy(false);
    }
  };
  const wipe = async () => {
    setBusy(true);
    try {
      await jsonFetch("/api/mimic/settings", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) });
      setMsg("All Mimic data was deleted.");
      setConfirm("");
      onDeleted();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <section className={cn(card, "space-y-4")}>
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-[14.5px] font-medium">Emergency stop</span>
            <span className="text-[13px] text-s-ink-2">Stops every automation at once. Nothing runs until you turn it off.</span>
          </span>
          <Switch checked={data.settings.stopped} disabled={busy} onChange={(v) => set({ stopped: v })} label="Emergency stop" />
        </label>
        <label className="flex items-start justify-between gap-4">
          <span>
            <span className="block text-[14.5px] font-medium">AI reading</span>
            <span className="text-[13px] text-s-ink-2">Use an AI model for details the labels can&apos;t find. Its answers are kept only if they appear in the invoice. Uses your plan&apos;s AI allowance.</span>
          </span>
          <Switch checked={data.settings.aiReading} disabled={busy} onChange={(v) => set({ aiReading: v })} label="AI reading" />
        </label>
      </section>
      <section className={card}>
        <h2 className="text-[15px] font-semibold">What Mimic stores</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-s-ink-2">
          <li>Your demonstrations: which text went into which field, never your screen, keystrokes or passwords.</li>
          <li>The text of invoices you add or test with, the drafts it creates, the rules you approve and an audit log.</li>
          <li>All of it is private to your account. Invoice text is treated as data: instructions inside a document are flagged, never followed.</li>
        </ul>
      </section>
      <section className={card}>
        <h2 className="text-[15px] font-semibold">Delete all Mimic data</h2>
        <p className="mt-1 text-[13px] text-s-ink-2">Removes your automations, runs, rules, inbox, Demo Books drafts and the audit log. This can&apos;t be undone.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Type DELETE" aria-label="Type DELETE to confirm" className="h-9 w-40 rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px]" />
          <button type="button" onClick={wipe} disabled={busy || confirm !== "DELETE"} className="h-9 rounded-xl border border-rose-500/50 px-4 text-[13.5px] text-rose-700 hover:bg-rose-500/10 disabled:opacity-50 dark:text-rose-300">
            Delete everything
          </button>
        </div>
        {msg && <p className="mt-2 text-[13px] text-s-ink-2">{msg}</p>}
      </section>
    </div>
  );
}
