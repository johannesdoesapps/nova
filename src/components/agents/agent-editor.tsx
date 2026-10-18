"use client";
import { useState } from "react";
import { Check } from "lucide-react";
import type { ModelWithStatus } from "@/lib/ai/types";
import { agentInput, type AgentInput } from "@/lib/agents/schema";
import { AGENT_ACCENTS, AGENT_CAPABILITIES, AGENT_ICONS, CAPABILITY_INFO, HISTORY_LIMITS, RESPONSE_STYLE_INFO, RESPONSE_STYLES, type AgentConfig, type CapabilityStatus } from "@/lib/agents/types";
import { AUTO_MODEL_ID } from "@/lib/ai/platform";
import { cn } from "@/lib/utils";
import { Dialog, Switch } from "@/components/studio/ui";
import { ACCENT_COLORS, AGENT_ICON_COMPONENTS, AgentAvatar, CAPABILITY_ICONS } from "./agent-visuals";
import { saveAgent } from "./use-agents";

const EMPTY: AgentInput = {
  name: "",
  description: "",
  instructions: "",
  icon: "bot",
  accent: "violet",
  modelId: null,
  capabilities: ["file_analysis"],
  starters: [],
  responseStyle: "balanced",
  historyLimit: 20,
};

const field =
  "w-full rounded-xl border border-s-line-strong bg-transparent px-3.5 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-[color-mix(in_srgb,var(--s-accent)_45%,transparent)] focus-visible:outline-none aria-[invalid=true]:border-s-danger";
const label = "mb-1.5 block text-[13px] font-medium";
const errorText = "mt-1.5 text-[12.5px] text-s-danger";

/**
 * Create or edit a custom agent. `editing` is the agent being changed; `draft`
 * pre-fills a new agent (used when duplicating). The dialog closes only after
 * the agent has actually been saved.
 */
export function AgentEditor({
  open,
  editing,
  draft,
  capabilities,
  models,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: AgentConfig | null;
  draft: AgentInput | null;
  capabilities: CapabilityStatus;
  models: ModelWithStatus[] | null;
  onClose: () => void;
  onSaved: (agent: AgentConfig, created: boolean) => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? `Edit ${editing.name}` : "Create agent"}
      description={editing ? "Changes apply to new messages in every conversation with this agent." : "Give your assistant a role, a look and the tools it may use."}
      width={640}
    >
      {open && (
        <EditorForm
          key={editing?.id ?? "new"}
          initial={editing ? toFormValue(editing) : (draft ?? EMPTY)}
          editingId={editing?.id}
          capabilities={capabilities}
          models={models}
          onCancel={onClose}
          onSaved={onSaved}
        />
      )}
    </Dialog>
  );
}

function toFormValue(a: AgentConfig): AgentInput {
  return {
    name: a.name,
    description: a.description,
    instructions: a.instructions,
    icon: a.icon,
    accent: a.accent,
    modelId: a.modelId,
    capabilities: a.capabilities,
    starters: a.starters,
    responseStyle: a.responseStyle,
    historyLimit: a.historyLimit,
  };
}

function EditorForm({
  initial,
  editingId,
  capabilities,
  models,
  onCancel,
  onSaved,
}: {
  initial: AgentInput;
  editingId?: string;
  capabilities: CapabilityStatus;
  models: ModelWithStatus[] | null;
  onCancel: () => void;
  onSaved: (agent: AgentConfig, created: boolean) => void;
}) {
  const [v, setV] = useState<AgentInput>(initial);
  const [starters, setStarters] = useState(initial.starters.join("\n"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const patch = (p: Partial<AgentInput>) => {
    setV((x) => ({ ...x, ...p }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(p)) delete next[k];
      return next;
    });
  };

  const submit = async () => {
    setFormError(null);
    const parsed = agentInput.safeParse({
      ...v,
      // A copied agent may list a tool this deployment lacks; it stays off until set up.
      capabilities: v.capabilities.filter((c) => capabilities[c].available),
      starters: starters
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const issue of parsed.error.issues) next[String(issue.path[0])] ??= issue.message;
      setErrors(next);
      const first = Object.keys(next)[0];
      document.getElementById(`agent-${first}`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const agent = await saveAgent(parsed.data, editingId);
      onSaved(agent, !editingId);
    } catch (e) {
      setFormError((e as Error).message || "The agent couldn't be saved.");
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-5"
    >
      <div className="flex items-start gap-4">
        <AgentAvatar agent={v} size="lg" className="mt-1" />
        <div className="min-w-0 flex-1">
          <label htmlFor="agent-name" className={label}>
            Name
          </label>
          <input
            id="agent-name"
            value={v.name}
            onChange={(e) => patch({ name: e.target.value })}
            maxLength={80}
            placeholder="e.g. Thesis Research Coach"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "agent-name-err" : undefined}
            className={cn(field, "h-10")}
          />
          {errors.name && <p id="agent-name-err" className={errorText}>{errors.name}</p>}
        </div>
      </div>

      <div>
        <label htmlFor="agent-description" className={label}>
          Description <span className="font-normal text-s-ink-3">· shown on the agent’s card</span>
        </label>
        <input
          id="agent-description"
          value={v.description}
          onChange={(e) => patch({ description: e.target.value })}
          maxLength={300}
          placeholder="What does this agent help with?"
          aria-invalid={!!errors.description}
          className={cn(field, "h-10")}
        />
        {errors.description && <p className={errorText}>{errors.description}</p>}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3">
          <label htmlFor="agent-instructions" className="text-[13px] font-medium">
            Instructions
          </label>
          <span className="text-[12px] tabular-nums text-s-ink-3">{v.instructions.length.toLocaleString()} / 8,000</span>
        </div>
        <textarea
          id="agent-instructions"
          value={v.instructions}
          onChange={(e) => patch({ instructions: e.target.value })}
          rows={7}
          maxLength={8000}
          placeholder={"Describe the agent's role, expertise and behaviour.\ne.g. You are a patient tutor for first-year statistics. Explain with small worked examples and check understanding with one question at the end."}
          aria-invalid={!!errors.instructions}
          aria-describedby="agent-instructions-hint"
          className={cn(field, "s-scroll resize-y py-2.5 leading-relaxed")}
        />
        {errors.instructions ? (
          <p className={errorText}>{errors.instructions}</p>
        ) : (
          <p id="agent-instructions-hint" className="mt-1.5 text-[12.5px] text-s-ink-3">
            NOVA’s safety rules always apply on top of these instructions.
          </p>
        )}
      </div>

      <fieldset>
        <legend className={label}>Icon</legend>
        <div role="radiogroup" aria-label="Icon" className="grid grid-cols-8 gap-1.5">
          {AGENT_ICONS.map((i) => {
            const Icon = AGENT_ICON_COMPONENTS[i];
            const on = v.icon === i;
            return (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={i}
                title={i}
                onClick={() => patch({ icon: i })}
                className={cn(
                  "grid aspect-square place-items-center rounded-xl border transition [&_svg]:h-[18px] [&_svg]:w-[18px]",
                  on ? "border-transparent bg-s-accent-soft text-s-accent" : "border-s-line text-s-ink-2 hover:bg-s-hover hover:text-s-ink",
                )}
              >
                <Icon />
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend className={label}>Accent</legend>
        <div role="radiogroup" aria-label="Accent colour" className="flex flex-wrap gap-2">
          {AGENT_ACCENTS.map((a) => {
            const on = v.accent === a;
            return (
              <button
                key={a}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={a}
                title={a}
                onClick={() => patch({ accent: a })}
                className={cn("grid h-8 w-8 place-items-center rounded-full ring-offset-2 ring-offset-[var(--s-bg)] transition", on && "ring-2 ring-s-ink-3")}
                style={{ background: ACCENT_COLORS[a] }}
              >
                {on && <Check className="h-4 w-4 text-white" />}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div>
        <label htmlFor="agent-model" className={label}>
          Default model
        </label>
        <select
          id="agent-model"
          value={v.modelId ?? ""}
          onChange={(e) => patch({ modelId: e.target.value || null })}
          className={cn(field, "h-10 bg-s-bg")}
        >
          <option value="">Site default</option>
          <option value={AUTO_MODEL_ID}>Auto (routes each message by task type)</option>
          {models
            ?.filter((m) => m.available || m.id === v.modelId)
            .map((m) => (
              <option key={m.id} value={m.id} disabled={!m.available}>
                {m.displayName}
                {m.available ? "" : " — no longer available"}
              </option>
            ))}
        </select>
        <p className="mt-1.5 text-[12.5px] text-s-ink-3">People can still switch models in a conversation; the agent&apos;s instructions and tools stay the same.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className={label}>Response style</legend>
          <div role="radiogroup" aria-label="Response style" className="flex rounded-xl border border-s-line-strong p-0.5">
            {RESPONSE_STYLES.map((s) => (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={v.responseStyle === s}
                title={RESPONSE_STYLE_INFO[s].instruction}
                onClick={() => patch({ responseStyle: s })}
                className={cn(
                  "h-9 flex-1 rounded-[10px] text-[13px] transition",
                  v.responseStyle === s ? "bg-s-ink text-s-bg" : "text-s-ink-2 hover:bg-s-hover hover:text-s-ink",
                )}
              >
                {RESPONSE_STYLE_INFO[s].label}
              </button>
            ))}
          </div>
        </fieldset>
        <div>
          <label htmlFor="agent-memory" className={label}>
            Conversation memory
          </label>
          <select
            id="agent-memory"
            value={v.historyLimit}
            onChange={(e) => patch({ historyLimit: Number(e.target.value) })}
            className={cn(field, "h-10 bg-s-bg")}
          >
            {HISTORY_LIMITS.map((n) => (
              <option key={n} value={n}>
                Last {n} messages{n === 20 ? " (recommended)" : n === 40 ? " (uses more of your allowance)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset>
        <legend className={label}>Capabilities</legend>
        <ul className="divide-y divide-s-line rounded-2xl border border-s-line">
          {AGENT_CAPABILITIES.map((c) => {
            const status = capabilities[c];
            const on = v.capabilities.includes(c);
            return (
              <li key={c} className={cn("flex items-start gap-3 px-3.5 py-3", !status.available && "opacity-70")}>
                <span className="mt-0.5 text-s-ink-2 [&_svg]:h-4 [&_svg]:w-4">{CAPABILITY_ICONS[c]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
                    {CAPABILITY_INFO[c].label}
                    {!status.available && <span className="rounded-full border border-s-line-strong px-2 py-px text-[11px] text-s-ink-3">Requires setup</span>}
                  </div>
                  <p className="mt-0.5 text-[12.5px] leading-snug text-s-ink-3">{status.available ? CAPABILITY_INFO[c].description : status.reason}</p>
                </div>
                <Switch
                  label={CAPABILITY_INFO[c].label}
                  checked={on && status.available}
                  disabled={!status.available}
                  onChange={(next) => patch({ capabilities: next ? [...v.capabilities, c] : v.capabilities.filter((x) => x !== c) })}
                />
              </li>
            );
          })}
        </ul>
        {errors.capabilities && <p className={errorText}>{errors.capabilities}</p>}
      </fieldset>

      <div>
        <label htmlFor="agent-starters" className={label}>
          Starter prompts <span className="font-normal text-s-ink-3">· optional, one per line, up to 4</span>
        </label>
        <textarea
          id="agent-starters"
          value={starters}
          onChange={(e) => {
            setStarters(e.target.value);
            setErrors((e) => {
              const next = { ...e };
              delete next.starters;
              return next;
            });
          }}
          rows={3}
          placeholder={"Explain this concept with an example.\nQuiz me on chapter 3."}
          aria-invalid={!!errors.starters}
          className={cn(field, "s-scroll resize-y py-2.5 leading-relaxed")}
        />
        {errors.starters && <p className={errorText}>{errors.starters}</p>}
      </div>

      {formError && (
        <p role="alert" className="rounded-xl border border-s-line bg-s-hover px-3.5 py-2.5 text-[13px] text-s-danger">
          {formError}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="inline-flex h-10 items-center rounded-xl border border-s-line-strong px-4 text-[13.5px] font-medium transition hover:bg-s-hover">
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-10 items-center rounded-xl bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110 active:scale-[0.98] disabled:opacity-60"
        >
          {saving ? "Saving…" : editingId ? "Save changes" : "Create agent"}
        </button>
      </div>
    </form>
  );
}
