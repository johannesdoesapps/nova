"use client";
import { useEffect, useMemo, useState } from "react";
import { CircleCheck, CircleAlert, ExternalLink, Plus, Trash2 } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { PlatformSettings } from "@/lib/ai/platform";
import { CAPABILITIES } from "@/lib/ai/registry";
import type { Capability, ModelInfo, ModelWithStatus, ProviderId } from "@/lib/ai/types";
import { modelUnits } from "@/lib/plans";
import { cn } from "@/lib/utils";
import { useApp } from "@/components/layout/app-context";
import { StudioHeader } from "@/components/studio/frame";
import { ProviderMark } from "@/components/studio/model-selector";
import { Switch } from "@/components/studio/ui";
import { FinancePanel } from "./finance-panel";
import { ProductPanel } from "./product-panel";
import { AnswerCheckPanel } from "./answer-check-panel";
import { PlansEditor } from "./plans-editor";
import { RequestLog } from "./request-log";

type ProviderRow = { id: Exclude<ProviderId, "demo">; label: string; envVar: string; keyUrl: string; steps: string; configured: boolean };
type Snapshot = { settings: PlatformSettings; models: ModelWithStatus[]; providers: ProviderRow[] };
type TestResult = { ok: boolean; models?: string[]; error?: string };
type CustomModel = PlatformSettings["customModels"][number];

const card = "glass rounded-[22px] p-5";
const field =
  "h-10 w-full rounded-xl border border-s-line-strong bg-transparent px-3 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-[color-mix(in_srgb,var(--s-accent)_45%,transparent)]";
const btn = "inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[13px] font-medium transition active:scale-[0.98] disabled:opacity-50";

export function AdminView() {
  const { user } = useApp();
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<PlatformSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({});
  const [adding, setAdding] = useState<Partial<ModelInfo> | null>(null);

  useEffect(() => {
    if (!user?.isAdmin) return;
    let alive = true;
    jsonFetch<Snapshot>("/api/admin/settings")
      .then((s) => {
        if (!alive) return;
        setSnap(s);
        setDraft(s.settings);
      })
      .catch((e: Error) => alive && setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [user?.isAdmin]);

  const dirty = useMemo(() => !!snap && !!draft && JSON.stringify(snap.settings) !== JSON.stringify(draft), [snap, draft]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (!user?.isAdmin) {
    return (
      <>
        <StudioHeader>
          <span className="text-[14px] font-medium text-s-ink-2">Admin</span>
        </StudioHeader>
        <div className="grid flex-1 place-items-center px-6 text-center">
          <h1 className="text-[14px] font-normal text-s-ink-2">Only site administrators can open this page.</h1>
        </div>
      </>
    );
  }

  const models = snap ? [...snap.models, ...(draft?.customModels ?? []).filter((c) => !snap.models.some((m) => m.id === c.id)).map((c) => ({ ...c, available: false }))] : [];
  const enabled = (id: string) => !draft?.enabledModelIds || draft.enabledModelIds.includes(id);
  const patch = (p: Partial<PlatformSettings>) => {
    setStatus(null);
    setDraft((d) => (d ? { ...d, ...p } : d));
  };
  const setEnabled = (id: string, on: boolean) => {
    const all = models.map((m) => m.id);
    const current = draft?.enabledModelIds ?? all;
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id);
    patch({ enabledModelIds: all.every((x) => next.includes(x)) ? null : next });
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setStatus(null);
    try {
      const s = await jsonFetch<Snapshot>("/api/admin/settings", { method: "PUT", body: JSON.stringify(draft) });
      setSnap(s);
      setDraft(s.settings);
      setStatus({ tone: "ok", text: "Saved. New chats use these settings right away." });
    } catch (e) {
      setStatus({ tone: "error", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const test = async (provider: string) => {
    setTests((t) => ({ ...t, [provider]: "running" }));
    try {
      const r = await jsonFetch<TestResult>("/api/admin/providers/test", { method: "POST", body: JSON.stringify({ provider }) });
      setTests((t) => ({ ...t, [provider]: r }));
    } catch (e) {
      setTests((t) => ({ ...t, [provider]: { ok: false, error: (e as Error).message } }));
    }
  };

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Admin</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[960px] space-y-6 px-4 pb-28 pt-2 sm:px-8">
          <div className="s-in">
            <h1 className="font-serif text-[clamp(32px,5vw,42px)] leading-[1.05]">AI platform</h1>
            <p className="mt-2 text-[15px] text-s-ink-2">Providers, models, Auto mode, plans, prices and finances for this site.</p>
          </div>

          {loadError && <p className="rounded-xl border border-s-line px-4 py-3 text-[13.5px] text-s-danger">{loadError}</p>}
          {!snap && !loadError && <div className="s-skeleton h-40 rounded-[22px]" />}

          {snap && draft && (
            <>
              <section aria-labelledby="providers-h">
                <h2 id="providers-h" className="mb-3 text-[15px] font-semibold">
                  Providers
                </h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {snap.providers.map((p) => {
                    const t = tests[p.id];
                    return (
                      <div key={p.id} className={card}>
                        <div className="flex items-center gap-3">
                          <ProviderMark provider={p.id} />
                          <div className="min-w-0 flex-1">
                            <div className="text-[14px] font-medium">{p.label}</div>
                            <code className="text-[12px] text-s-ink-3">{p.envVar}</code>
                          </div>
                          <span className={cn("rounded-full px-2 py-0.5 text-[11.5px]", p.configured ? "bg-s-accent-soft text-s-accent" : "border border-s-line-strong text-s-ink-3")}>
                            {p.configured ? "Key set" : "Not configured"}
                          </span>
                        </div>
                        {p.configured ? (
                          <div className="mt-3">
                            <button type="button" onClick={() => test(p.id)} disabled={t === "running"} className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}>
                              {t === "running" ? "Testing…" : "Test connection"}
                            </button>
                            {t && t !== "running" && (
                              <div className="mt-2 text-[12.5px]">
                                {t.ok ? (
                                  <p className="flex items-center gap-1.5 text-s-ink-2">
                                    <CircleCheck className="h-3.5 w-3.5 text-s-accent" /> Key works · {t.models?.length ?? 0} models available
                                  </p>
                                ) : (
                                  <p className="flex items-center gap-1.5 text-s-danger">
                                    <CircleAlert className="h-3.5 w-3.5" /> {t.error}
                                  </p>
                                )}
                                {t.ok && !!t.models?.length && (
                                  <details className="mt-1.5">
                                    <summary className="cursor-pointer text-s-ink-3 hover:text-s-ink">Show model IDs to add</summary>
                                    <ul className="s-scroll mt-1.5 max-h-40 space-y-0.5 overflow-y-auto">
                                      {t.models.map((id) => {
                                        const known = models.some((m) => m.provider === p.id && m.providerModelId === id);
                                        return (
                                          <li key={id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-s-hover">
                                            <code className="truncate text-[12px]">{id}</code>
                                            {known ? (
                                              <span className="text-[11px] text-s-ink-3">In registry</span>
                                            ) : (
                                              <button
                                                type="button"
                                                className="text-[12px] text-s-accent hover:underline"
                                                onClick={() => setAdding({ provider: p.id, providerModelId: id, id: `${p.id}:${id}`, displayName: id, capabilities: ["chat"] })}
                                              >
                                                Add
                                              </button>
                                            )}
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </details>
                                )}
                              </div>
                            )}
                          </div>
                        ) : (
                          <p className="mt-3 text-[12.5px] leading-relaxed text-s-ink-3">
                            {p.steps}{" "}
                            <a href={p.keyUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-s-accent hover:underline">
                              Get a key <ExternalLink className="h-3 w-3" />
                            </a>
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[12px] text-s-ink-3">
                  API keys live only in your hosting environment variables (e.g. Vercel → Settings → Environment Variables). They are never stored in the database or sent to browsers.
                </p>
              </section>

              <section aria-labelledby="behaviour-h" className={card}>
                <h2 id="behaviour-h" className="text-[15px] font-semibold">
                  Behaviour
                </h2>
                <div className="mt-3 divide-y divide-s-line">
                  <label className="flex items-start justify-between gap-4 py-3">
                    <span>
                      <span className="block text-[14px]">Auto mode</span>
                      <span className="block text-[12.5px] text-s-ink-3">Lets users pick &ldquo;Auto&rdquo;, which routes each message by task type using published rules.</span>
                    </span>
                    <Switch label="Auto mode" checked={draft.autoEnabled} onChange={(v) => patch({ autoEnabled: v })} />
                  </label>
                  <label className="flex items-start justify-between gap-4 py-3">
                    <span>
                      <span className="block text-[14px]">Backup models</span>
                      <span className="block text-[12.5px] text-s-ink-3">
                        If a model fails before answering, a compatible model may answer instead, possibly from another provider. Users must also turn this on, and are always told.
                      </span>
                    </span>
                    <Switch label="Backup models" checked={draft.fallbackEnabled} onChange={(v) => patch({ fallbackEnabled: v })} />
                  </label>
                  <div className="py-3">
                    <span className="block text-[14px]">Default limits for a coding-agent task</span>
                    <span className="block text-[12.5px] text-s-ink-3">
                      Applies to new tasks. When a task reaches a limit it pauses and asks the user to allow more or stop; it never continues on its own. Leave empty for the built-in defaults.
                    </span>
                    <div className="mt-2 flex flex-wrap gap-3">
                      <label className="flex items-center gap-2 text-[13px]">
                        Tokens per task
                        <input
                          type="number"
                          min={10_000}
                          max={10_000_000}
                          step={10_000}
                          placeholder="600000"
                          value={draft.taskLimits?.tokenBudget ?? ""}
                          onChange={(e) => patch({ taskLimits: { ...draft.taskLimits, tokenBudget: e.target.value ? Number(e.target.value) : undefined } })}
                          className={cn(field, "w-[130px] bg-s-bg")}
                        />
                      </label>
                      <label className="flex items-center gap-2 text-[13px]">
                        Minutes per task
                        <input
                          type="number"
                          min={1}
                          max={240}
                          placeholder="30"
                          value={draft.taskLimits?.timeLimitMinutes ?? ""}
                          onChange={(e) => patch({ taskLimits: { ...draft.taskLimits, timeLimitMinutes: e.target.value ? Number(e.target.value) : undefined } })}
                          className={cn(field, "w-[90px] bg-s-bg")}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <label htmlFor="default-model" className="text-[14px]">
                      Default model
                    </label>
                    <select
                      id="default-model"
                      value={draft.defaultModelId ?? ""}
                      onChange={(e) => patch({ defaultModelId: e.target.value || null })}
                      className={cn(field, "w-auto min-w-[220px] bg-s-bg")}
                    >
                      <option value="">Lowest-cost available (recommended)</option>
                      {models
                        .filter((m) => enabled(m.id))
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.displayName}
                            {m.available ? "" : " (provider not configured)"}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              </section>

              <section aria-labelledby="models-h" className={card}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="models-h" className="text-[15px] font-semibold">
                    Models
                  </h2>
                  <button type="button" onClick={() => setAdding({ provider: "anthropic", capabilities: ["chat"] })} className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}>
                    <Plus className="h-4 w-4" /> Add model
                  </button>
                </div>
                <p className="mt-1 text-[12.5px] text-s-ink-3">Units per message count against users&apos; 5-hour and weekly allowance. Defaults: 1 for low-cost models, 15 for larger ones.</p>
                <ul className="mt-3 divide-y divide-s-line">
                  {models.map((m) => {
                    const custom = draft.customModels.some((c) => c.id === m.id);
                    const units = draft.modelUnits[m.id];
                    return (
                      <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
                        <ProviderMark provider={m.provider} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-[14px]">
                            {m.displayName}
                            {!m.available && <span className="rounded-full border border-s-line-strong px-1.5 py-px text-[10.5px] text-s-ink-3">Provider not configured</span>}
                            {custom && <span className="rounded-full border border-s-line-strong px-1.5 py-px text-[10.5px] text-s-ink-3">Added by admin</span>}
                          </div>
                          <code className="text-[11.5px] text-s-ink-3">{m.providerModelId}</code>
                        </div>
                        <label className="flex items-center gap-1.5 text-[12.5px] text-s-ink-3">
                          Units
                          <input
                            type="number"
                            min={0}
                            max={100}
                            value={units ?? modelUnits(m.capabilities)}
                            onChange={(e) => {
                              const n = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
                              const next = { ...draft.modelUnits };
                              if (n === modelUnits(m.capabilities)) delete next[m.id];
                              else next[m.id] = n;
                              patch({ modelUnits: next });
                            }}
                            className={cn(field, "h-8 w-16 px-2 text-[13px]")}
                            aria-label={`Units per message for ${m.displayName}`}
                          />
                        </label>
                        <Switch label={`Enable ${m.displayName}`} checked={enabled(m.id)} onChange={(v) => setEnabled(m.id, v)} />
                        {custom && (
                          <button
                            type="button"
                            aria-label={`Remove ${m.displayName}`}
                            onClick={() => patch({ customModels: draft.customModels.filter((c) => c.id !== m.id) })}
                            className="grid h-8 w-8 place-items-center rounded-lg text-s-ink-3 transition hover:bg-s-hover hover:text-s-danger"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <FinancePanel />
              <ProductPanel />
              <AnswerCheckPanel />

              <PlansEditor stored={draft.billing} models={snap.models} onChange={(billing) => patch({ billing: billing as unknown as Record<string, unknown> })} />

              <RequestLog />

              {adding && (
                <AddModel
                  initial={adding}
                  existing={models.map((m) => m.id)}
                  onCancel={() => setAdding(null)}
                  onAdd={(m) => {
                    patch({ customModels: [...draft.customModels, m] });
                    setAdding(null);
                  }}
                />
              )}
            </>
          )}
        </div>
      </div>

      {snap && draft && (dirty || status) && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-[calc(16px+env(safe-area-inset-bottom))]">
          <div className="glass-strong glass-edge pointer-events-auto flex w-full max-w-[640px] flex-wrap items-center gap-3 rounded-2xl px-4 py-3 shadow-[var(--s-shadow)]">
            <p role="status" className={cn("min-w-0 flex-1 text-[13px]", status?.tone === "error" ? "text-s-danger" : "text-s-ink-2")}>
              {status?.text ?? "You have unsaved changes."}
            </p>
            {dirty && (
              <>
                <button type="button" onClick={() => (setDraft(snap.settings), setStatus(null))} className={cn(btn, "hover:bg-s-hover")}>
                  Discard
                </button>
                <button type="button" onClick={save} disabled={saving} className={cn(btn, "bg-s-accent text-s-accent-ink hover:brightness-110")}>
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function AddModel({ initial, existing, onCancel, onAdd }: { initial: Partial<ModelInfo>; existing: string[]; onCancel: () => void; onAdd: (m: CustomModel) => void }) {
  const [v, setV] = useState({
    provider: (initial.provider ?? "anthropic") as Exclude<ProviderId, "demo">,
    providerModelId: initial.providerModelId ?? "",
    displayName: initial.displayName ?? "",
    description: initial.description ?? "",
    capabilities: (initial.capabilities ?? ["chat"]) as Capability[],
  });
  const [error, setError] = useState<string | null>(null);
  const id = `${v.provider}:${v.providerModelId.trim()}`;

  const submit = () => {
    if (!v.providerModelId.trim()) return setError("Enter the provider's model ID.");
    if (!v.displayName.trim()) return setError("Give the model a display name.");
    if (existing.includes(id)) return setError("That model is already in the registry.");
    onAdd({
      id,
      provider: v.provider,
      providerModelId: v.providerModelId.trim(),
      displayName: v.displayName.trim(),
      description: v.description.trim(),
      capabilities: v.capabilities.length ? v.capabilities : ["chat"],
      contextWindow: null,
      inputPrice: null,
      outputPrice: null,
      isEnabled: true,
      lastVerifiedAt: null,
      priceSourceUrl: null,
    });
  };

  return (
    <section aria-labelledby="add-h" className={cn(card, "s-in")}>
      <h2 id="add-h" className="text-[15px] font-semibold">
        Add a model
      </h2>
      <p className="mt-1 text-[12.5px] text-s-ink-3">Use the exact ID from the provider (Test connection lists them). Prices stay unset until you verify them.</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px]">
          Provider
          <select value={v.provider} onChange={(e) => setV({ ...v, provider: e.target.value as typeof v.provider })} className={cn(field, "mt-1 bg-s-bg")}>
            <option value="anthropic">Anthropic</option>
            <option value="openai">OpenAI</option>
            <option value="google">Google</option>
            <option value="xai">xAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="zai">Z.ai (GLM)</option>
            <option value="huggingface">Hugging Face</option>
          </select>
        </label>
        <label className="block text-[13px]">
          Model ID
          <input value={v.providerModelId} onChange={(e) => setV({ ...v, providerModelId: e.target.value })} className={cn(field, "mt-1")} placeholder="e.g. gemini-…" />
        </label>
        <label className="block text-[13px]">
          Display name
          <input value={v.displayName} onChange={(e) => setV({ ...v, displayName: e.target.value })} className={cn(field, "mt-1")} />
        </label>
        <label className="block text-[13px]">
          Short description
          <input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} className={cn(field, "mt-1")} maxLength={200} />
        </label>
      </div>
      <fieldset className="mt-3">
        <legend className="text-[13px]">Capabilities (used for categories, Auto mode and agent defaults)</legend>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {CAPABILITIES.map((c) => {
            const on = v.capabilities.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => setV({ ...v, capabilities: on ? v.capabilities.filter((x) => x !== c) : [...v.capabilities, c] })}
                className={cn("h-7 rounded-full border px-2.5 text-[12px] transition", on ? "border-transparent bg-s-ink text-s-bg" : "border-s-line text-s-ink-2 hover:border-s-line-strong")}
              >
                {c}
              </button>
            );
          })}
        </div>
      </fieldset>
      {error && <p className="mt-2 text-[12.5px] text-s-danger">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={cn(btn, "border border-s-line-strong hover:bg-s-hover")}>
          Cancel
        </button>
        <button type="button" onClick={submit} className={cn(btn, "bg-s-accent text-s-accent-ink hover:brightness-110")}>
          Add to list
        </button>
      </div>
      <p className="mt-2 text-[12px] text-s-ink-3">Added models are saved with &ldquo;Save changes&rdquo;.</p>
    </section>
  );
}
