"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { track } from "@vercel/analytics";
import { ArrowLeft, ArrowRight, Check, Eye, LayoutTemplate, Monitor, Smartphone, Sparkles, X } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { useCatalog } from "@/components/common/model-picker";
import { StudioHeader } from "@/components/studio/frame";
import { ModelSelector } from "@/components/studio/model-selector";
import { Dialog, Segmented } from "@/components/studio/ui";
import type { ProjectSummary } from "@/lib/code/projects";
import {
  appendSuggestion,
  isSiteTemplateId,
  PROMPT_SUGGESTIONS,
  SITE_TEMPLATE_LIST,
  SITE_TEMPLATES,
  templateRequest,
  TONES,
  type SiteTemplate,
  type SiteTemplateId,
  type TemplateDetails,
} from "@/lib/code/site-templates";
import { siteName } from "@/lib/code/site-examples";
import { cn } from "@/lib/utils";
import { CodeApiError, post, putBuildRequest } from "./api";
import { useCodeModel } from "./use-code-model";

/**
 * Discover → "Build a website from a prompt": choose one of four website
 * templates, describe the site, and the coding agent builds it in a new
 * project that starts from the template's files. The step and the chosen
 * template live in the address (?template=…&step=describe), so Back and
 * Forward move between the steps; the request being written is kept for the
 * tab's session, so it survives going back, previewing or signing in.
 */

const DRAFT_KEY = "orbis:site-draft";
const EMPTY_DETAILS: TemplateDetails = { name: "", color: "", tone: "", audience: "", sections: "" };
/** The address each template's sample site shows in its browser frame. */
const HOSTS: Record<SiteTemplateId, string> = {
  "launchpad-saas": "cadence.so",
  "atelier-portfolio": "ateliernord.studio",
  "form-found-store": "formandfound.shop",
  "journal-personal": "noraellison.com",
  "nova-creative-agency": "nova.agency",
};

interface Draft {
  prompt: string;
  details: TemplateDetails;
}

function readDraft(): Draft | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? "null") as Partial<Draft> | null;
    if (!v || typeof v.prompt !== "string") return null;
    const d = (v.details ?? {}) as Partial<TemplateDetails>;
    const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 300) : "");
    return { prompt: v.prompt.slice(0, 6_000), details: { name: str(d.name), color: str(d.color), tone: str(d.tone), audience: str(d.audience), sections: str(d.sections) } };
  } catch {
    return null;
  }
}

function writeDraft(d: Draft | null) {
  try {
    if (d && (d.prompt.trim() || Object.values(d.details).some(Boolean))) sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    /* storage blocked: the request still works, it just isn't kept across reloads */
  }
}

const event = (name: string, template?: SiteTemplateId) => track(name, template ? { template } : {});

export function SiteTemplatesView() {
  const { user } = useApp();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const asked = params.get("template");
  const selected = isSiteTemplateId(asked) ? asked : null;
  const missing = !!asked && !selected;
  const describing = params.get("step") === "describe" && !!selected;

  const [preview, setPreview] = useState<SiteTemplateId | null>(null);
  const [prompt, setPrompt] = useState("");
  const [details, setDetails] = useState<TemplateDetails>(EMPTY_DETAILS);

  // The request written earlier in this tab (before previewing, signing in or reloading).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const d = readDraft();
    if (!d) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring the saved draft once, after hydration (storage isn't readable on the server)
    setPrompt(d.prompt);
    setDetails(d.details);
  }, []);
  useEffect(() => {
    if (restored.current) writeDraft({ prompt, details });
  }, [prompt, details]);

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    event("website_gallery_opened");
  }, []);

  const go = useCallback(
    (template: SiteTemplateId | null, step: "gallery" | "describe", how: "push" | "replace") => {
      const q = new URLSearchParams();
      if (template) q.set("template", template);
      if (step === "describe" && template) q.set("step", "describe");
      const href = q.size ? `${pathname}?${q}` : pathname;
      if (how === "push" && step === "describe" && template) {
        // Back from the describe step returns to the gallery with this template selected.
        window.history.replaceState(window.history.state, "", `${pathname}?template=${template}`);
        router.push(href, { scroll: true });
      } else if (how === "push") router.push(href, { scroll: true });
      else router.replace(href, { scroll: false });
    },
    [pathname, router],
  );

  const select = useCallback(
    (id: SiteTemplateId) => {
      if (id !== selected) event("website_template_selected", id);
      go(id, "gallery", "replace");
    },
    [go, selected],
  );
  const use = useCallback(
    (id: SiteTemplateId) => {
      event("website_template_selected", id);
      setPreview(null);
      go(id, "describe", "push");
    },
    [go],
  );
  const openPreview = useCallback((id: SiteTemplateId) => {
    event("website_template_preview", id);
    setPreview(id);
  }, []);

  return (
    <>
      <StudioHeader>
        <span className="text-[14px] font-medium text-s-ink-2">Build a website</span>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1320px] px-4 pb-24 pt-3 sm:px-8">
          {describing && selected ? (
            <DescribeStep
              template={SITE_TEMPLATES[selected]}
              prompt={prompt}
              setPrompt={setPrompt}
              details={details}
              setDetails={setDetails}
              signedIn={!!user}
              onChange={() => go(selected, "gallery", "push")}
              onDone={() => writeDraft(null)}
            />
          ) : (
            <Gallery selected={selected} missing={missing} onSelect={select} onUse={use} onPreview={openPreview} />
          )}
        </div>
      </div>
      <PreviewDialog id={preview} onClose={() => setPreview(null)} onUse={use} />
    </>
  );
}

/* Steps ------------------------------------------------------------------- */

const STEPS = ["Choose a template", "Describe your idea", "Generate your website"];

function StepIndicator({ current }: { current: 0 | 1 }) {
  return (
    <ol aria-label="Steps" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-s-ink-3">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i === current ? "step" : undefined} className="flex items-center gap-2">
          {i > 0 && (
            <span aria-hidden className="text-s-ink-3/60">
              →
            </span>
          )}
          <span className={cn("tabular-nums", i === current ? "font-medium text-s-ink" : i < current ? "text-s-ink-2" : "")}>
            {String(i + 1).padStart(2, "0")} {s}
          </span>
        </li>
      ))}
    </ol>
  );
}

function BackLink({ href, children, onClick }: { href?: string; children: ReactNode; onClick?: () => void }) {
  const cls = "inline-flex h-8 items-center gap-1.5 rounded-full pr-3 text-[13px] text-s-ink-2 transition hover:text-s-ink";
  return href ? (
    <Link href={href} className={cls}>
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {children}
    </Link>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> {children}
    </button>
  );
}

/* Gallery ----------------------------------------------------------------- */

function Gallery({
  selected,
  missing,
  onSelect,
  onUse,
  onPreview,
}: {
  selected: SiteTemplateId | null;
  missing: boolean;
  onSelect: (id: SiteTemplateId) => void;
  onUse: (id: SiteTemplateId) => void;
  onPreview: (id: SiteTemplateId) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink href="/discover">Back to Discover</BackLink>
        <StepIndicator current={0} />
      </div>
      <header className="mt-6 max-w-3xl sm:mt-8">
        <p className="inline-flex items-center gap-2 text-[13px] font-medium text-s-ink-2">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-s-accent-soft text-s-ink [&_svg]:h-3.5 [&_svg]:w-3.5">
            <Sparkles aria-hidden />
          </span>
          Build something beautiful.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="font-serif text-[clamp(30px,4.6vw,46px)] leading-[1.06] tracking-[-0.01em]">Choose your starting point</h1>
          <span className="rounded-full border border-s-line px-2.5 py-0.5 text-[12px] text-s-ink-2">{SITE_TEMPLATE_LIST.length} curated templates</span>
        </div>
        <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-s-ink-2">Choose a starting point, describe your idea, and let AI bring your website to life.</p>
      </header>

      {missing && (
        <p role="alert" className="mt-5 max-w-2xl rounded-xl border border-s-line-strong px-3.5 py-2.5 text-[13px] text-s-ink-2">
          That template isn&apos;t available. Choose one of these four instead.
        </p>
      )}

      <div className="@container mt-8">
        {/* Rows of three (two, one on narrow screens), the last row centred. */}
        <ul className="flex flex-wrap justify-center gap-6" aria-label="Website templates">
          {SITE_TEMPLATE_LIST.map((t, i) => (
            <li key={t.id} className="w-full @[520px]:w-[calc(50%-12px)] @[900px]:w-[calc((100%-48px)/3)]">
              <TemplateCard template={t} selected={selected === t.id} eager={i < 2} onSelect={onSelect} onUse={onUse} onPreview={onPreview} />
            </li>
          ))}
        </ul>
      </div>

      <p className="mt-10 text-center text-[13.5px] text-s-ink-3">
        Don&apos;t want a template?{" "}
        <Link href="/code" onClick={() => event("website_start_from_scratch")} className="font-medium text-s-ink-2 underline underline-offset-4 hover:text-s-ink">
          Start from scratch
        </Link>
        .
      </p>
    </>
  );
}

/** A screenshot of the template's first screen, with its colours as the fallback if the image can't load. */
function Shot({ template, eager, sizes, className }: { template: SiteTemplate; eager?: boolean; sizes: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return (
      <div
        role="img"
        aria-label={`${template.name} preview couldn't load`}
        className={cn("flex aspect-[960/810] w-full flex-col justify-end gap-2 p-4", className)}
        style={{ background: template.defaultColorPalette[0]!.hex === "#ffffff" ? "#f6f7fb" : template.defaultColorPalette[0]!.hex }}
      >
        <div className="flex gap-1.5">
          {template.defaultColorPalette.map((c) => (
            <span key={c.hex} className="h-4 w-4 rounded-full ring-1 ring-black/10" style={{ background: c.hex }} />
          ))}
        </div>
        <p className="text-[12px] text-black/60">Preview image unavailable. Open the full preview instead.</p>
      </div>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element -- pre-sized WebP screenshots from public/, chosen with srcSet
    <img
      src={template.previewImage.src}
      srcSet={`${template.thumbnailImage.src} ${template.thumbnailImage.width}w, ${template.previewImage.src} ${template.previewImage.width}w`}
      sizes={sizes}
      width={template.previewImage.width}
      height={template.previewImage.height}
      alt={`${template.name} website preview: ${template.visualDirection}`}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      onError={() => setFailed(true)}
      className={cn("block aspect-[960/810] h-auto w-full object-cover object-top", className)}
    />
  );
}

function BrowserBar({ host, className }: { host: string; className?: string }) {
  return (
    <div className={cn("flex h-7 items-center gap-1.5 border-b border-black/[0.06] bg-[#f3f3f5] px-3", className)} aria-hidden>
      <i className="h-2 w-2 rounded-full bg-[#ff5f57]" />
      <i className="h-2 w-2 rounded-full bg-[#febc2e]" />
      <i className="h-2 w-2 rounded-full bg-[#28c840]" />
      <span className="mx-auto max-w-[60%] truncate rounded-md bg-white px-3 py-0.5 text-[10.5px] text-black/60">{host}</span>
    </div>
  );
}

const TemplateCard = memo(function TemplateCard({
  template: t,
  selected,
  eager,
  onSelect,
  onUse,
  onPreview,
}: {
  template: SiteTemplate;
  selected: boolean;
  eager: boolean;
  onSelect: (id: SiteTemplateId) => void;
  onUse: (id: SiteTemplateId) => void;
  onPreview: (id: SiteTemplateId) => void;
}) {
  return (
    <article
      className={cn(
        "group relative flex h-full flex-col rounded-[22px] border bg-s-glass-strong p-2.5 transition duration-200 motion-safe:hover:-translate-y-1 hover:shadow-[0_18px_40px_-18px_rgba(0,0,0,0.35)]",
        selected ? "border-s-ink shadow-[0_0_0_1px_var(--color-s-ink)]" : "border-s-line hover:border-s-line-strong",
      )}
    >
      <div className="relative overflow-hidden rounded-[14px] border border-black/[0.06] bg-white">
        <BrowserBar host={HOSTS[t.id]} />
        <button type="button" onClick={() => onSelect(t.id)} aria-pressed={selected} aria-label={`Select ${t.name}`} className="block w-full overflow-hidden focus-visible:outline-none">
          <Shot template={t} eager={eager} sizes="(min-width: 1400px) 420px, (min-width: 700px) 45vw, 92vw" className="transition-transform duration-200 motion-safe:group-hover:scale-[1.015]" />
        </button>
        {selected && (
          <span className="pointer-events-none absolute right-2.5 top-9 inline-flex items-center gap-1 rounded-full bg-s-ink px-2.5 py-1 text-[11.5px] font-medium text-s-bg shadow">
            <Check className="h-3 w-3" aria-hidden strokeWidth={3} /> Selected
          </span>
        )}
        <button
          type="button"
          onClick={() => onPreview(t.id)}
          className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-full bg-black/80 px-3.5 py-1.5 text-[12.5px] font-medium text-white opacity-0 shadow-lg backdrop-blur transition duration-200 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:hidden"
        >
          <Eye className="h-3.5 w-3.5" aria-hidden /> Preview template
        </button>
      </div>
      <div className="flex flex-1 flex-col px-1.5 pb-1.5 pt-4">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{t.name}</h2>
        <p className="mt-0.5 text-[12px] font-medium uppercase tracking-[0.06em] text-s-ink-3">{t.category}</p>
        <p className="mt-1.5 flex-1 text-[13.5px] leading-snug text-s-ink-2">{t.description}</p>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => onUse(t.id)}
            className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-full bg-s-accent px-4 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110"
          >
            Use template <span className="sr-only">{t.name}</span>
          </button>
          <button
            type="button"
            onClick={() => onPreview(t.id)}
            aria-label={`Preview ${t.name}`}
            title="Preview template"
            className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-s-line text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink"
          >
            <Eye className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>
    </article>
  );
});

/* Preview ----------------------------------------------------------------- */

const DESKTOP = 1280;
const PHONE = 390;

/** The template's real page in a sandboxed frame (no scripts, forms or navigation), scaled to fit. */
function LiveFrame({ template, device }: { template: SiteTemplate; device: "desktop" | "mobile" }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  // Which page and size has finished loading, so switching to the other size shows "Loading…" again.
  const view = `${template.id}:${device}`;
  const [loadedView, setLoadedView] = useState<string | null>(null);
  const loaded = loadedView === view;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: Math.round(Math.min(window.innerHeight * 0.58, 720)) });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pageWidth = device === "desktop" ? DESKTOP : PHONE;
  const frameWidth = device === "desktop" ? size.w : Math.min(size.w, PHONE);
  const scale = frameWidth ? Math.min(1, frameWidth / pageWidth) : 0;
  return (
    <div ref={box} className="w-full">
      <div
        className={cn("mx-auto overflow-hidden rounded-[14px] border border-black/10 bg-white shadow-[0_24px_60px_-28px_rgba(0,0,0,0.45)]", device === "mobile" && "rounded-[26px]")}
        style={{ width: frameWidth || "100%" }}
      >
        <BrowserBar host={HOSTS[template.id]} />
        <div className="relative overflow-hidden" style={{ height: size.h }}>
          {!loaded && <div className="absolute inset-0 grid place-items-center text-[13px] text-black/50">Loading preview…</div>}
          {scale > 0 && (
            <iframe
              key={device}
              title={`${template.name} template, ${device} preview`}
              src={template.page}
              sandbox=""
              referrerPolicy="no-referrer"
              loading="lazy"
              onLoad={() => setLoadedView(view)}
              className="absolute left-0 top-0 origin-top-left border-0 bg-white"
              style={{ width: pageWidth, height: size.h / scale, transform: `scale(${scale})` }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewDialog({ id, onClose, onUse }: { id: SiteTemplateId | null; onClose: () => void; onUse: (id: SiteTemplateId) => void }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const t = id ? SITE_TEMPLATES[id] : null;
  return (
    <Dialog open={!!t} onClose={onClose} title={t ? `${t.name} · ${t.category}` : "Template preview"} description={t?.visualDirection} width={1180}>
      {t && (
        <div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <Segmented
              label="Preview size"
              value={device}
              onChange={setDevice}
              options={[
                { value: "desktop", label: "Desktop", icon: <Monitor aria-hidden /> },
                { value: "mobile", label: "Mobile", icon: <Smartphone aria-hidden /> },
              ]}
            />
            <p className="text-[12px] text-s-ink-3">The real page, scrollable. Names, prices and quotes are sample content.</p>
          </div>
          <LiveFrame template={t} device={device} />
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-10 items-center gap-1.5 rounded-full border border-s-line px-4 text-[13.5px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Back to templates
            </button>
            <button
              type="button"
              onClick={() => onUse(t.id)}
              className="inline-flex h-10 items-center gap-1.5 rounded-full bg-s-accent px-5 text-[13.5px] font-medium text-s-accent-ink transition hover:brightness-110"
            >
              Use this template <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/* Describe ---------------------------------------------------------------- */

const field = "mt-1 h-10 w-full rounded-xl border border-s-line bg-transparent px-3 text-[13.5px] text-s-ink placeholder:text-s-ink-3 focus:border-s-line-strong focus:outline-none";

function DescribeStep({
  template: t,
  prompt,
  setPrompt,
  details,
  setDetails,
  signedIn,
  onChange,
  onDone,
}: {
  template: SiteTemplate;
  prompt: string;
  setPrompt: (v: string) => void;
  details: TemplateDetails;
  setDetails: (fn: (d: TemplateDetails) => TemplateDetails) => void;
  signedIn: boolean;
  onChange: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const box = useRef<HTMLTextAreaElement>(null);
  const catalog = useCatalog();
  const [modelId, setModelId] = useCodeModel(catalog);
  const [more, setMore] = useState(() => Object.values(details).some(Boolean));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CodeApiError | null>(null);
  const [empty, setEmpty] = useState(false);
  const sending = useRef(false);
  /** The project a failed attempt already made for this template, so trying again doesn't make another. */
  const created = useRef<{ template: SiteTemplateId; id: string } | null>(null);

  useEffect(() => {
    box.current?.focus({ preventScroll: true });
  }, []);

  const addSuggestion = (s: string) => {
    setPrompt(appendSuggestion(prompt, s));
    setEmpty(false);
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };

  const generate = async () => {
    if (sending.current) return;
    if (!prompt.trim()) {
      setEmpty(true);
      box.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    event("website_prompt_submitted", t.id);
    try {
      const name = details.name.trim() ? `Website: ${details.name.trim().slice(0, 50)}` : siteName(prompt.trim());
      let pid = created.current?.template === t.id ? created.current.id : null;
      if (!pid) {
        pid = (await post<{ project: ProjectSummary }>("/api/code/projects", { name, template: "website", siteTemplate: t.id })).project.id;
        created.current = { template: t.id, id: pid };
      }
      putBuildRequest(pid, templateRequest(prompt, details), [], modelId, t.id);
      event("website_generation_started", t.id);
      onDone();
      router.push(`/code/${pid}?build=1`);
    } catch (e) {
      setError(e instanceof CodeApiError ? e : new CodeApiError((e as Error).message || "Something went wrong. Try again.", 0, null, null));
      setBusy(false);
      sending.current = false;
    }
  };

  const describePath = `/code/website?template=${t.id}&step=describe`;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <BackLink onClick={onChange}>Back to templates</BackLink>
        <StepIndicator current={1} />
      </div>

      <div className="mx-auto mt-6 max-w-[820px] sm:mt-8">
        <section aria-label="Selected template" className="flex items-center gap-3 rounded-2xl border border-s-line bg-s-glass-strong p-2.5 pr-4">
          <div className="w-[88px] shrink-0 overflow-hidden rounded-lg border border-black/[0.06] bg-white sm:w-[112px]">
            <Shot template={t} eager sizes="112px" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-s-ink-3">Starting with</p>
            <p className="truncate text-[15px] font-semibold">{t.name}</p>
            <p className="text-[12.5px] leading-snug text-s-ink-3">{t.category}</p>
          </div>
          <button type="button" onClick={onChange} className="shrink-0 text-[13px] font-medium text-s-ink-2 underline underline-offset-4 hover:text-s-ink">
            Change template
          </button>
        </section>

        <h1 className="mt-8 font-serif text-[clamp(28px,4vw,40px)] leading-[1.08] tracking-[-0.01em]">What would you like to build?</h1>
        <p className="mt-2 text-[15px] text-s-ink-2">Describe your idea in your own words. We&apos;ll use your chosen template as the starting point.</p>

        <form
          className="mt-5"
          onSubmit={(e) => {
            e.preventDefault();
            void generate();
          }}
        >
          <label htmlFor="site-prompt" className="sr-only">
            Describe your website
          </label>
          <textarea
            id="site-prompt"
            ref={box}
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              if (e.target.value.trim()) setEmpty(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void generate();
              }
            }}
            rows={7}
            maxLength={6_000}
            aria-invalid={empty || undefined}
            aria-describedby={empty ? "site-prompt-error" : "site-prompt-hint"}
            placeholder={`For example: ${t.promptExample}`}
            className={cn(
              "block min-h-[180px] w-full resize-y rounded-[20px] border bg-s-glass-strong px-4 py-3.5 text-[15px] leading-relaxed text-s-ink shadow-[var(--s-shadow-sm)] placeholder:text-s-ink-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-s-ink/25",
              empty ? "border-s-danger" : "border-s-line focus:border-s-line-strong",
            )}
          />
          {empty ? (
            <p id="site-prompt-error" role="alert" className="mt-2 text-[12.5px] text-s-danger">
              Describe your website first: what it&apos;s for and what it should include.
            </p>
          ) : (
            <p id="site-prompt-hint" className="mt-2 text-[12.5px] text-s-ink-3">
              Say what it&apos;s for, who it&apos;s for and the sections you want. The template sets the look; your words decide the content.
            </p>
          )}

          <div className="mt-4">
            <p id="suggestions-label" className="text-[12.5px] text-s-ink-3">
              Add to your description
            </p>
            <ul aria-labelledby="suggestions-label" className="mt-2 flex flex-wrap gap-1.5">
              {PROMPT_SUGGESTIONS.map((s) => {
                const added = prompt.toLowerCase().includes(s.toLowerCase());
                return (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => addSuggestion(s)}
                      disabled={added}
                      className="inline-flex h-8 items-center gap-1 rounded-full border border-s-line px-3 text-[12.5px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink disabled:cursor-default disabled:border-transparent disabled:bg-s-hover disabled:text-s-ink-3"
                    >
                      {added ? <Check className="h-3 w-3" aria-hidden /> : <span aria-hidden>+</span>} {s}
                      {added && <span className="sr-only"> (added)</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="mt-5 border-t border-s-line pt-4">
            <button
              type="button"
              onClick={() => setMore((x) => !x)}
              aria-expanded={more}
              aria-controls="site-options"
              className="text-[13px] text-s-ink-2 underline-offset-4 hover:text-s-ink hover:underline"
            >
              {more ? "Hide options" : "Options (optional): name, brand colour, tone, audience, sections"}
            </button>
            {more && (
              <div id="site-options" className="mt-3 grid gap-3 sm:grid-cols-2">
                <label className="block text-[12.5px] text-s-ink-3">
                  Website name
                  <input value={details.name} onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))} maxLength={60} placeholder="e.g. Lumen" className={field} />
                </label>
                <div className="text-[12.5px] text-s-ink-3">
                  <label htmlFor="site-color">Primary brand colour</label>
                  <div className="mt-1 flex items-center gap-2">
                    <input
                      id="site-color"
                      type="color"
                      value={details.color || t.defaultColorPalette[1]!.hex}
                      onChange={(e) => setDetails((d) => ({ ...d, color: e.target.value }))}
                      className="h-10 w-12 shrink-0 cursor-pointer rounded-lg border border-s-line bg-transparent p-1"
                    />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-s-ink-2">{details.color ? details.color.toUpperCase() : `Template's own (${t.defaultColorPalette[1]!.name})`}</span>
                    {details.color && (
                      <button
                        type="button"
                        onClick={() => setDetails((d) => ({ ...d, color: "" }))}
                        aria-label="Use the template's colour"
                        className="grid h-8 w-8 place-items-center rounded-full text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    )}
                  </div>
                </div>
                <label className="block text-[12.5px] text-s-ink-3">
                  Tone or visual style
                  <select value={details.tone} onChange={(e) => setDetails((d) => ({ ...d, tone: e.target.value }))} className={cn(field, "pr-2")}>
                    {TONES.map((x) => (
                      <option key={x} value={x}>
                        {x || "Template's own"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-[12.5px] text-s-ink-3">
                  Target audience
                  <input value={details.audience} onChange={(e) => setDetails((d) => ({ ...d, audience: e.target.value }))} maxLength={200} placeholder="e.g. small design teams" className={field} />
                </label>
                <label className="block text-[12.5px] text-s-ink-3 sm:col-span-2">
                  Pages or sections you need
                  <input
                    value={details.sections}
                    onChange={(e) => setDetails((d) => ({ ...d, sections: e.target.value }))}
                    maxLength={200}
                    placeholder={`e.g. ${t.sectionPresets
                      .slice(1, 5)
                      .map((s) => s.label.toLowerCase())
                      .join(", ")}`}
                    className={field}
                  />
                </label>
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="mt-4 rounded-xl border border-s-danger/40 px-3.5 py-2.5 text-[13px] text-s-danger">
              {error.message}{" "}
              {error.upgrade && (
                <Link href="/pricing" className="underline">
                  See plans
                </Link>
              )}
              {error.details?.scope === "code_projects" ? (
                <>
                  {" "}
                  <Link href="/code" className="underline">
                    Your projects
                  </Link>
                </>
              ) : null}{" "}
              Your description is kept; try again when you&apos;re ready.
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {signedIn ? (
              <button
                type="submit"
                disabled={busy}
                aria-busy={busy || undefined}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-s-accent px-6 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110 disabled:opacity-60"
              >
                <Sparkles className="h-4 w-4" aria-hidden /> {busy ? "Creating your project…" : "Generate website"}
              </button>
            ) : (
              <Link
                href={`/login?next=${encodeURIComponent(describePath)}`}
                className="inline-flex h-11 items-center gap-2 rounded-full bg-s-accent px-6 text-[14px] font-medium text-s-accent-ink transition hover:brightness-110"
              >
                Sign in to generate
              </Link>
            )}
            <button
              type="button"
              onClick={onChange}
              className="inline-flex h-11 items-center gap-1.5 rounded-full border border-s-line px-4 text-[13.5px] text-s-ink-2 transition hover:border-s-line-strong hover:text-s-ink"
            >
              <LayoutTemplate className="h-4 w-4" aria-hidden /> Change template
            </button>
            {signedIn && <ModelSelector models={catalog?.models ?? null} value={modelId} onChange={setModelId} auto={catalog?.auto ?? null} className="min-w-0 !shrink" />}
            <Link href="/code" onClick={() => event("website_start_from_scratch")} className="ml-auto text-[13px] text-s-ink-3 underline-offset-4 hover:text-s-ink hover:underline">
              Start from scratch
            </Link>
          </div>
          <p className="mt-4 text-[12px] leading-relaxed text-s-ink-3">
            A new project is created from the {t.name} template. The coding agent then rewrites it for your request, runs it on the project&apos;s private computer (this uses workspace minutes),
            checks it at desktop, tablet and phone sizes, and reports what it did. Nothing is published, and the template doesn&apos;t include payments, sign-in, a database or email sending.
          </p>
        </form>
      </div>
    </>
  );
}
