"use client";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, Sparkles } from "lucide-react";
import { MODEL_CATEGORIES, inCategory, modelTags, priceLabel, recommendedIds, type ModelCategory } from "@/lib/ai/catalog";
import { ROUTER_MODES, autoIdFor, isAutoId, routerModeOf } from "@/lib/ai/platform";
import { routerPool } from "@/lib/ai/router";
import { PROVIDER_INFO, providerLabel } from "@/lib/ai/provider-info";
import type { ModelWithStatus, ProviderId } from "@/lib/ai/types";
import { cn } from "@/lib/utils";

const PROVIDER_ORDER: ProviderId[] = ["anthropic", "openai", "google", "xai", "deepseek", "huggingface", "demo"];

/** A neutral monogram per provider (not a brand logo). */
export function ProviderMark({ provider, className }: { provider: ProviderId | "auto"; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid h-7 w-7 shrink-0 place-items-center rounded-[9px] border border-s-line-strong bg-s-glass text-[11px] font-semibold tracking-tight text-s-ink-2",
        provider === "auto" && "border-transparent bg-s-accent-soft text-s-accent",
        className,
      )}
    >
      {provider === "auto" ? <Sparkles className="h-3.5 w-3.5" /> : provider === "demo" ? "D" : PROVIDER_INFO[provider].short}
    </span>
  );
}

type Option = { id: string; kind: "auto" } | { id: string; kind: "model"; model: ModelWithStatus };

export function ModelSelector({
  models,
  value,
  onChange,
  auto,
  className,
}: {
  models: ModelWithStatus[] | null;
  value: string | undefined;
  onChange: (id: string) => void;
  auto: { enabled: boolean; reason: string | null } | null;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ModelCategory | "all">("all");
  const [active, setActive] = useState(0);
  const [style, setStyle] = useState<CSSProperties>({});
  const [sheet, setSheet] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const available = useMemo(() => (models ?? []).filter((m) => m.available), [models]);
  const hiddenCount = (models ?? []).filter((m) => !m.available && m.provider !== "demo").length;
  const recommended = useMemo(() => recommendedIds(available), [available]);
  const categories = MODEL_CATEGORIES.filter((c) => available.some((m) => inCategory(m, c.id, recommended)));
  const selected = available.find((m) => m.id === value);
  const isAuto = isAutoId(value);
  const autoMode = ROUTER_MODES.find((m) => m.id === routerModeOf(value))!;
  // The models each Smart Router mode chooses from, named in its title.
  const modePools = useMemo(
    () => Object.fromEntries(ROUTER_MODES.map((m) => [m.id, routerPool(models ?? [], m.id).filter((x) => x.available).map((x) => x.displayName)])),
    [models],
  );

  const q = query.trim().toLowerCase();
  const filtered = available.filter(
    (m) =>
      (category === "all" || inCategory(m, category, recommended)) &&
      (!q || `${m.displayName} ${providerLabel(m.provider)} ${m.description} ${m.capabilities.join(" ")}`.toLowerCase().includes(q)),
  );
  const showAuto = !!auto && category === "all" && (!q || `auto automatic smart router ${ROUTER_MODES.map((m) => m.label).join(" ")}`.toLowerCase().includes(q));
  const groups = PROVIDER_ORDER.map((p) => ({ provider: p, models: filtered.filter((m) => m.provider === p) })).filter((g) => g.models.length);
  const options: Option[] = [
    ...(showAuto && auto?.enabled ? ROUTER_MODES.map((m) => ({ id: autoIdFor(m.id), kind: "auto" as const })) : []),
    ...groups.flatMap((g) => g.models.map((m) => ({ id: m.id, kind: "model" as const, model: m }))),
  ];
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const toggle = () => {
    if (open) return close();
    const r = triggerRef.current!.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const mobile = vw < 640;
    setSheet(mobile);
    if (!mobile) {
      const w = Math.min(380, vw - 16);
      const up = r.bottom > vh * 0.55;
      setStyle({
        position: "fixed",
        width: w,
        left: Math.max(8, Math.min(r.right - w, vw - w - 8)),
        ...(up ? { bottom: vh - r.top + 8 } : { top: r.bottom + 8 }),
        maxHeight: Math.min(520, up ? r.top - 16 : vh - r.bottom - 16),
        transformOrigin: `right ${up ? "bottom" : "top"}`,
        ["--s-pop-y" as string]: up ? "4px" : "-4px",
      });
    }
    setQuery("");
    setCategory("all");
    const i = Math.max(0, [...(auto?.enabled ? ROUTER_MODES.map((m) => autoIdFor(m.id)) : []), ...PROVIDER_ORDER.flatMap((p) => available.filter((m) => m.provider === p).map((m) => m.id))].indexOf(value ?? ""));
    setActive(i);
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listId]);

  const choose = (id: string) => {
    onChange(id);
    close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!options.length) return;
      setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const o = options[activeIndex];
      if (o) choose(o.id);
    }
  };

  const indexOf = new Map(options.map((o, i) => [o.id, i]));
  const rowClass = (id: string) =>
    cn(
      "flex w-full cursor-pointer items-start gap-3 rounded-xl px-2.5 py-2 text-left transition",
      indexOf.get(id) === activeIndex ? "bg-s-hover" : "hover:bg-s-hover",
    );

  const label = isAuto ? (autoMode.id === "balanced" ? "Auto" : `Auto · ${autoMode.label}`) : (selected?.displayName ?? (models ? "Choose model" : "Loading…"));

  const panel = (
    <div
      ref={panelRef}
      onKeyDown={onKeyDown}
      style={sheet ? undefined : style}
      className={cn(
        "glass-strong glass-solid glass-edge z-50 flex flex-col overflow-hidden",
        sheet ? "s-in fixed inset-x-0 bottom-0 max-h-[78dvh] rounded-t-[26px] pb-[env(safe-area-inset-bottom)]" : "s-pop rounded-2xl",
      )}
      role="dialog"
      aria-label="Choose a model"
    >
      {sheet && <div className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-s-line-strong" aria-hidden />}
      <div className="shrink-0 space-y-2 p-2 pb-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-s-ink-3" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            placeholder="Search models"
            aria-label="Search models"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={options.length ? `${listId}-${activeIndex}` : undefined}
            className="h-9 w-full rounded-xl border border-transparent bg-s-hover pl-9 pr-3 text-[13.5px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-s-line-strong focus:bg-transparent focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        {categories.length > 1 && (
          <div role="tablist" aria-label="Model categories" className="-mx-2 flex gap-1 overflow-x-auto px-2 pb-0.5 [scrollbar-width:none]">
            {[{ id: "all" as const, label: "All" }, ...categories].map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={category === c.id}
                onClick={() => {
                  setCategory(c.id);
                  setActive(0);
                  inputRef.current?.focus();
                }}
                className={cn(
                  "h-7 shrink-0 rounded-full border px-2.5 text-[12px] transition",
                  category === c.id ? "border-transparent bg-s-ink text-s-bg" : "border-s-line text-s-ink-2 hover:border-s-line-strong hover:text-s-ink",
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div id={listId} role="listbox" aria-label="Models" className="s-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {showAuto &&
          (auto?.enabled ? (
            <div role="group" aria-label="Smart Router">
              <div className="px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-s-ink-3">Smart Router</div>
              {ROUTER_MODES.map((mode) => {
                const id = autoIdFor(mode.id);
                return (
                  <div
                    key={id}
                    id={`${listId}-${indexOf.get(id)}`}
                    role="option"
                    aria-selected={value === id}
                    onPointerEnter={() => setActive(indexOf.get(id) ?? 0)}
                    onClick={() => choose(id)}
                    className={cn(rowClass(id), "items-center py-1.5")}
                  >
                    <ProviderMark provider="auto" className={cn(mode.id !== "balanced" && "bg-transparent text-s-ink-2")} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13.5px] leading-snug">
                        <span className="font-medium">{mode.id === "balanced" ? "Auto" : `Auto · ${mode.label}`}</span>
                        {modePools[mode.id]?.length ? <span className="text-s-ink-2"> — {joinOr(modePools[mode.id]!)}</span> : null}
                      </div>
                      <p className="text-[12px] leading-snug text-s-ink-3">{mode.blurb}</p>
                    </div>
                    {value === id && <Check className="h-4 w-4 shrink-0 text-s-accent" />}
                  </div>
                );
              })}
              <a
                href="/council"
                className="mx-2.5 mt-1 flex items-center justify-between rounded-lg px-0 py-1.5 text-[12.5px] text-s-ink-3 transition hover:text-s-ink"
              >
                <span>Council: ask several models at once</span>
                <span aria-hidden>→</span>
              </a>
            </div>
          ) : (
            <div className="flex items-start gap-3 rounded-xl px-2.5 py-2 opacity-60" aria-disabled>
              <ProviderMark provider="auto" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px] font-medium">Auto</div>
                <p className="mt-0.5 text-[12.5px] leading-snug text-s-ink-3">Unavailable: {auto?.reason ?? "not set up."} Choose a model below.</p>
              </div>
            </div>
          ))}

        {groups.map((g) => (
          <div key={g.provider} role="group" aria-label={providerLabel(g.provider)}>
            <div className="px-2.5 pb-1 pt-2.5 text-[11.5px] font-medium uppercase tracking-[0.08em] text-s-ink-3">{providerLabel(g.provider)}</div>
            {g.models.map((m) => {
              const tags = modelTags(m);
              const price = priceLabel(m);
              return (
                <div
                  key={m.id}
                  id={`${listId}-${indexOf.get(m.id)}`}
                  role="option"
                  aria-selected={value === m.id}
                  onPointerEnter={() => setActive(indexOf.get(m.id) ?? 0)}
                  onClick={() => choose(m.id)}
                  className={rowClass(m.id)}
                >
                  <ProviderMark provider={m.provider} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium">
                      {m.displayName}
                      {m.isDefault && <span className="rounded-full bg-s-accent-soft px-1.5 py-px text-[10.5px] font-medium text-s-accent">Default</span>}
                      {m.provider === "demo" && <span className="rounded-full border border-s-line-strong px-1.5 py-px text-[10.5px] text-s-ink-3">Simulated</span>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-s-ink-3">{m.description}</p>
                    {(tags.length > 0 || price) && (
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-s-ink-3">
                        {tags.map((t) => (
                          <span key={t} className="rounded-md border border-s-line px-1.5 py-px">
                            {t}
                          </span>
                        ))}
                        {price && <span className="px-0.5">{price}</span>}
                      </div>
                    )}
                  </div>
                  {value === m.id && <Check className="mt-1 h-4 w-4 shrink-0 text-s-accent" />}
                </div>
              );
            })}
          </div>
        ))}

        {models && !options.length && !(showAuto && !auto?.enabled) && (
          <p className="px-3 py-6 text-center text-[13px] text-s-ink-3">{available.length ? "No models match your search." : "No models are configured yet."}</p>
        )}
      </div>
      {hiddenCount > 0 && (
        <p className="shrink-0 border-t border-s-line px-3.5 py-2 text-[11.5px] text-s-ink-3">
          {hiddenCount} more model{hiddenCount === 1 ? "" : "s"} can be enabled by an administrator.
        </p>
      )}
    </div>
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        disabled={!models}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${label}`}
        title="Choose model"
        className={cn(
          "inline-flex h-9 max-w-[170px] items-center gap-1.5 rounded-full px-3 text-[13px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink disabled:opacity-50 sm:max-w-[240px]",
          open && "bg-s-hover text-s-ink",
          className,
        )}
      >
        {isAuto && <Sparkles className="h-3.5 w-3.5 shrink-0 text-s-accent" />}
        <span className="truncate">{label}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open &&
        createPortal(
          <>
            {sheet && <div className="fixed inset-0 z-40 bg-[var(--s-scrim)] backdrop-blur-[2px]" aria-hidden onClick={() => close()} />}
            {panel}
          </>,
          document.getElementById("studio-layer") ?? document.body,
        )}
    </>
  );
}

/** "A", "A or B", "A, B or C". */
function joinOr(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}
