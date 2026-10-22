"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowUp, Check, CodeXml, FileText, Globe, ImagePlus, Mic, Paperclip, Plus, Scale, ShieldCheck, ShieldQuestionMark, Square, Telescope, X } from "lucide-react";
import type { ModelWithStatus } from "@/lib/ai/types";
import { CHAT_MODES, MODE_LABELS, type ChatMode } from "@/lib/ai/modes";
import { ALLOWED_ATTACHMENT_EXT, MAX_ATTACHMENT_CHARS } from "@/lib/limits";
import { cn } from "@/lib/utils";
import { attachmentBytes, MAX_ATTACHMENTS_BYTES, type ChatAttachment } from "./chat-client";
import { GitHubLogo } from "@/components/common/login-form";
import { GitHubPicker } from "./github-picker";
import { IconButton, iconButtonClass, Menu, MenuItem, MenuLabel, MenuSeparator, Switch } from "./ui";
import { ModelSelector } from "./model-selector";
import { UsageNotice, useUsage, type UsageState } from "./usage";
import { isAutoId } from "@/lib/ai/platform";
import { recipientsFor } from "@/lib/ai/disclosure";
import { useApp } from "@/components/layout/app-context";
import { useStudio } from "./frame";

export const MODE_ICONS: Record<ChatMode, ReactNode> = {
  research: <Telescope />,
  analyst: <Scale />,
  critic: <ShieldQuestionMark />,
  coding: <CodeXml />,
};

const MAX_FILES = 3;
const MAX_FILE_BYTES = 512_000;

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  onStop: () => void;
  attachments: ChatAttachment[];
  onAttachments: (a: ChatAttachment[]) => void;
  models: ModelWithStatus[] | null;
  modelId: string | undefined;
  onModel: (id: string) => void;
  /** Auto mode availability; null hides the Auto option. */
  auto?: { enabled: boolean; reason: string | null } | null;
  mode: ChatMode;
  /** Omit to hide the mode menu (agents define their own behaviour). */
  onMode?: (m: ChatMode) => void;
  useWeb: boolean;
  onUseWeb: (v: boolean) => void;
  webAvailable: boolean;
  /** Whether web search may be used here; defaults to "in Research mode". */
  webAllowed?: boolean;
  webBlockedHint?: string;
  /** Whether files may be attached here (agents need File analysis). */
  filesAllowed?: boolean;
  placeholder?: string;
  enterToSend: boolean;
  variant: "hero" | "dock";
}

export function Composer(p: ComposerProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [githubOpen, setGithubOpen] = useState(false);
  const speech = useSpeech(p.onChange);
  const canSend = p.value.trim().length > 0 && !p.busy;

  // Grow with the content, up to a comfortable maximum, then scroll.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, p.variant === "hero" ? 260 : 220)}px`;
  }, [p.value, p.variant]);

  const webAllowed = p.webAllowed ?? p.mode === "research";
  const filesAllowed = p.filesAllowed ?? true;

  const addFiles = async (list: FileList | File[] | null) => {
    setFileError(null);
    if (!list) return;
    if (!filesAllowed) {
      setFileError("This agent can't read files. Turn on File analysis in its settings.");
      return;
    }
    const next = [...p.attachments];
    for (const f of Array.from(list)) {
      if (next.length >= MAX_FILES) {
        setFileError(`Up to ${MAX_FILES} files per message.`);
        break;
      }
      if (!ALLOWED_ATTACHMENT_EXT.some((ext) => f.name.toLowerCase().endsWith(ext))) {
        setFileError(`${f.name}: only text files (${ALLOWED_ATTACHMENT_EXT.join(", ")}) can be read right now.`);
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        setFileError(`${f.name} is larger than 500 KB.`);
        continue;
      }
      if (next.some((a) => a.name === f.name)) continue;
      let text = await f.text();
      if (text.length > MAX_ATTACHMENT_CHARS) {
        text = text.slice(0, MAX_ATTACHMENT_CHARS);
        setFileError(`${f.name} was trimmed to the first ${MAX_ATTACHMENT_CHARS.toLocaleString()} characters.`);
      }
      if (attachmentBytes([...next, { content: text }]) > MAX_ATTACHMENTS_BYTES) {
        setFileError(`${f.name} wasn’t added: a message’s files can total about ${Math.round(MAX_ATTACHMENTS_BYTES / 1000)} KB of text. Remove a file or attach a shorter one.`);
        continue;
      }
      next.push({ name: f.name, content: text });
    }
    p.onAttachments(next);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = () => {
    if (speech.listening) speech.stop();
    if (canSend) p.onSubmit();
  };

  const error = fileError ?? speech.error;
  const usage = useUsage(p.busy);

  return (
    <div className="w-full">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void addFiles(e.dataTransfer.files);
        }}
        className={cn("composer glass-strong glass-edge rounded-[26px] p-2", drag && "drag")}
      >
        <input
          ref={fileRef}
          id="studio-file"
          type="file"
          multiple
          hidden
          accept={ALLOWED_ATTACHMENT_EXT.join(",")}
          onChange={(e) => void addFiles(e.target.files)}
        />

        {p.attachments.length > 0 && (
          <ul className="flex flex-wrap gap-1.5 px-1.5 pb-1 pt-1.5" aria-label="Attached files">
            {p.attachments.map((a) => (
              <li key={a.name} className="s-pop flex items-center gap-2 rounded-xl border border-s-line bg-s-hover py-1.5 pl-2 pr-1 text-[12.5px]">
                <span className="grid h-6 w-6 place-items-center rounded-lg bg-s-accent-soft text-s-accent">
                  <FileText className="h-3.5 w-3.5" />
                </span>
                <span className="max-w-[180px] truncate">{a.name}</span>
                <IconButton size="sm" label={`Remove ${a.name}`} className="h-6 w-6" onClick={() => p.onAttachments(p.attachments.filter((x) => x.name !== a.name))}>
                  <X />
                </IconButton>
              </li>
            ))}
          </ul>
        )}

        <label htmlFor="studio-input" className="sr-only">Message Orbis</label>
        <textarea
          id="studio-input"
          ref={inputRef}
          value={p.value}
          onChange={(e) => p.onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            const mod = e.metaKey || e.ctrlKey;
            if ((p.enterToSend && !e.shiftKey && !mod) || (!p.enterToSend && mod)) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              void addFiles(e.clipboardData.files);
            }
          }}
          rows={1}
          maxLength={12000}
          placeholder={speech.listening ? "Listening…" : (p.placeholder ?? (p.variant === "hero" ? "Ask anything…" : "Message Orbis"))}
          className={cn(
            "s-scroll block w-full resize-none bg-transparent px-3 text-s-ink outline-none placeholder:text-s-ink-3 focus-visible:outline-none",
            p.variant === "hero" ? "min-h-[64px] pb-2 pt-3 text-[16.5px] leading-relaxed" : "min-h-[44px] pb-1.5 pt-2.5 text-[16px] leading-relaxed",
          )}
        />

        <div className="flex items-center gap-1 pt-1">
          <Menu
            label="Add to message"
            side="auto"
            width={276}
            buttonLabel="Add files and tools"
            buttonClassName={cn(iconButtonClass(), "rounded-full")}
            button={<Plus />}
          >
            <MenuItem
              icon={<Paperclip />}
              hint={filesAllowed ? "Text, Markdown, CSV or JSON · up to 3 · sent with your message to the model" : "Not enabled for this agent"}
              disabled={!filesAllowed}
              onClick={() => fileRef.current?.click()}
            >
              Upload files
            </MenuItem>
            <MenuItem
              icon={<GitHubLogo className="h-4 w-4" />}
              hint={filesAllowed ? "Files from repositories you choose" : "Not enabled for this agent"}
              disabled={!filesAllowed}
              onClick={() => setGithubOpen(true)}
            >
              Add from GitHub
            </MenuItem>
            <MenuItem icon={<ImagePlus />} hint="The connected models accept text only for now" disabled>
              Add images
            </MenuItem>
            <MenuSeparator />
            <div className="flex items-start gap-3 rounded-xl px-2.5 py-2">
              <Globe className="mt-px h-4 w-4 shrink-0 text-s-ink-2" />
              <div className="min-w-0 flex-1">
                <div className="text-[13.5px]">Search the web</div>
                <div className="mt-0.5 text-[12px] leading-snug text-s-ink-3">
                  {!webAllowed
                    ? (p.webBlockedHint ?? "Available in Research mode")
                    : !p.webAvailable
                      ? "Not set up on this site"
                      : "Cite live sources · your search terms go to the search provider"}
                </div>
              </div>
              <Switch label="Search the web" checked={p.useWeb && webAllowed} onChange={p.onUseWeb} disabled={!p.webAvailable || !webAllowed} />
            </div>
          </Menu>

          {p.onMode && (
            <Menu
              label="Assistant mode"
              side="auto"
              width={300}
              buttonLabel={`Mode: ${MODE_LABELS[p.mode].label}`}
              buttonTitle="Assistant mode"
              buttonClassName="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink [&_svg]:h-4 [&_svg]:w-4"
              button={
                <>
                  {MODE_ICONS[p.mode]}
                  <span className="hidden sm:inline">{MODE_LABELS[p.mode].label}</span>
                </>
              }
            >
                  <MenuLabel>Mode</MenuLabel>
                  {CHAT_MODES.map((m) => (
                    <MenuItem
                      key={m}
                      role="menuitemradio"
                      checked={p.mode === m}
                      icon={MODE_ICONS[m]}
                      hint={MODE_LABELS[m].blurb}
                      right={p.mode === m ? <Check /> : null}
                      onClick={() => p.onMode?.(m)}
                    >
                      {MODE_LABELS[m].label}
                    </MenuItem>
                  ))}
            </Menu>
          )}

          {p.useWeb && webAllowed && p.webAvailable && (
            <button
              type="button"
              onClick={() => p.onUseWeb(false)}
              className="s-pop hidden h-8 items-center gap-1.5 rounded-full bg-s-accent-soft px-2.5 text-[12.5px] text-s-accent sm:inline-flex"
              title="Web search is on — click to turn off"
            >
              <Globe className="h-3.5 w-3.5" /> Web
            </button>
          )}

          {/* The model name gives way on narrow screens so Send always fits. */}
          <div className="ml-auto flex min-w-0 items-center gap-1 [&>*]:shrink-0">
            <WhereItGoes models={p.models} modelId={p.modelId} web={p.useWeb && webAllowed && p.webAvailable} files={p.attachments.length} />
            <ModelSelector models={p.models} value={p.modelId} onChange={p.onModel} auto={p.auto ?? null} className="min-w-0 !shrink" />

            {speech.supported && (
              <IconButton
                label={speech.listening ? "Stop voice input" : "Voice input"}
                active={speech.listening}
                onClick={() => (speech.listening ? speech.stop() : speech.start(p.value))}
                className={cn("rounded-full", speech.listening && "bg-s-accent-soft text-s-accent")}
                aria-pressed={speech.listening}
              >
                {speech.listening ? (
                  <span className="flex h-4 items-center gap-[3px]" aria-hidden>
                    <span className="s-dot h-2.5 w-[3px] rounded-full bg-current" />
                    <span className="s-dot h-4 w-[3px] rounded-full bg-current [animation-delay:120ms]" />
                    <span className="s-dot h-2.5 w-[3px] rounded-full bg-current [animation-delay:240ms]" />
                  </span>
                ) : (
                  <Mic />
                )}
              </IconButton>
            )}

            {p.busy ? (
              <button
                type="button"
                onClick={p.onStop}
                aria-label="Stop generating"
                title="Stop generating"
                className="s-pop grid h-9 w-9 place-items-center rounded-full bg-s-ink text-s-bg transition hover:opacity-85 active:scale-95"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send message"
                title={p.enterToSend ? "Send (Enter)" : "Send (Ctrl/⌘ + Enter)"}
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-full transition-all duration-200 active:scale-90",
                  canSend
                    ? "bg-s-accent text-s-accent-ink shadow-[0_6px_18px_-6px_var(--s-accent)] hover:-translate-y-px hover:brightness-110"
                    : "bg-s-hover text-s-ink-3",
                )}
              >
                <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </form>
      {error && (
        <p role="alert" className="s-in mt-2 px-3 text-[12.5px] text-s-danger">
          {error}
        </p>
      )}
      <UsageNotice usage={usage} />
      <ModelCostNotice models={p.models} modelId={p.modelId} usage={usage} autoOn={!!p.auto?.enabled} onModel={p.onModel} />
      {githubOpen && (
        <GitHubPicker open={githubOpen} onClose={() => setGithubOpen(false)} attachments={p.attachments} onAttachments={p.onAttachments} maxFiles={MAX_FILES} />
      )}
    </div>
  );
}

/* Voice input via the browser's Web Speech API (shown only where supported). */

interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

const noSubscribe = () => () => {};
function speechCtor(): RecognitionCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function useSpeech(onText: (t: string) => void) {
  const supported = useSyncExternalStore(noSubscribe, () => !!speechCtor(), () => false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(onText);
  useEffect(() => {
    cb.current = onText;
  });

  useEffect(() => () => rec.current?.stop(), []);

  const start = useCallback((base: string) => {
    const Ctor = speechCtor();
    if (!Ctor) return;
    setError(null);
    const r = new Ctor();
    r.continuous = true;
    r.interimResults = true;
    r.lang = navigator.language || "en-US";
    const prefix = base.trim() ? `${base.trimEnd()} ` : "";
    r.onresult = (e) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i]![0]!.transcript;
      cb.current(prefix + t.trim());
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(e.error === "not-allowed" || e.error === "service-not-allowed" ? "Microphone access is blocked for this site." : `Voice input stopped (${e.error}).`);
    };
    r.onend = () => setListening(false);
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setError("Voice input could not start.");
    }
  }, []);

  const stop = useCallback(() => rec.current?.stop(), []);
  return { supported, listening, error, start, stop };
}

/**
 * Before sending to a model that uses several units a message: how many, and
 * — when the allowance can't cover it — cheaper choices to switch to (the
 * user switches; nothing changes on its own).
 */
function ModelCostNotice({
  models,
  modelId,
  usage,
  autoOn,
  onModel,
}: {
  models: ModelWithStatus[] | null;
  modelId: string | undefined;
  usage: UsageState | null;
  autoOn: boolean;
  onModel: (id: string) => void;
}) {
  if (!models || !modelId || isAutoId(modelId)) return null;
  const m = models.find((x) => x.id === modelId);
  if (!m || m.units === undefined || m.units <= 1) return null;
  const left = usage && !usage.info?.unlimited ? Math.max(0, Math.min(usage.window.limit - usage.window.used, usage.week.limit - usage.week.used)) : null;
  const advancedSpent = !!usage?.budget && usage.budget.state === "economy" && m.units > 1;
  const short = (left !== null && left < m.units) || advancedSpent;
  const cheapest = models.filter((x) => x.available && !x.locked && x.units !== undefined && x.units < m.units!).sort((a, b) => a.units! - b.units!)[0];
  return (
    <p role="status" className={cn("s-in mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 text-[12.5px]", short ? "text-s-ink-2" : "text-s-ink-3")}>
      <span>
        {m.displayName} uses {m.units} units a message
        {short
          ? advancedSpent
            ? " — this month's allowance for larger models is used up."
            : ` — you have ${left} left until your limit resets.`
          : left !== null
            ? ` · ${left} left now.`
            : "."}
      </span>
      {short && autoOn && (
        <button type="button" onClick={() => onModel("auto")} className="rounded-full border border-s-line px-2 py-0.5 text-s-ink hover:bg-s-hover">
          Use Auto
        </button>
      )}
      {short && cheapest && (
        <button type="button" onClick={() => onModel(cheapest.id)} className="rounded-full border border-s-line px-2 py-0.5 text-s-ink hover:bg-s-hover">
          Use {cheapest.displayName} ({cheapest.units} unit{cheapest.units === 1 ? "" : "s"})
        </button>
      )}
    </p>
  );
}


/**
 * Before sending: which provider gets the message (all Auto might use, when
 * Auto chooses), what goes with it, and what Orbis keeps. Statements match
 * the Privacy Policy; nothing here promises more than it says.
 */
function WhereItGoes({ models, modelId, web, files }: { models: ModelWithStatus[] | null; modelId: string | undefined; web: boolean; files: number }) {
  const { user } = useApp();
  const studio = useStudio();
  if (!models || !modelId) return null;
  const { names, simulated, auto } = recipientsFor(models, modelId);
  const to = names.length ? names.join(auto ? " or " : ", ") : "the model's provider";
  return (
    <Menu
      label="Where your message goes"
      side="auto"
      align="end"
      width={330}
      buttonLabel={`Where your message goes: ${simulated ? "nowhere (simulated replies)" : to}`}
      buttonTitle="Where your message goes"
      buttonClassName={cn(iconButtonClass(), "h-8 w-8 text-s-ink-3")}
      button={<ShieldCheck />}
    >
      <div className="space-y-2 px-2.5 py-2 text-[12.5px] leading-relaxed text-s-ink-2">
        {simulated ? (
          <p>Replies are simulated on this site: your message isn’t sent to an AI provider.</p>
        ) : (
          <>
            <p>
              <span className="font-medium text-s-ink">Sent to {to}.</span> Your message, the earlier messages in this chat{files ? ` and the ${files} attached file${files === 1 ? "" : "s"}` : ""} go to
              them to write the reply.{auto ? " Auto picks the model for each message; the reply shows which one answered." : ""}
            </p>
            {user && <p className="text-s-ink-3">In a project chat, the project’s instructions (and notes, if you turned them on) go too. You choose this per project; other projects are never included.</p>}
            <p className="text-s-ink-3">Under their API terms, data sent through their APIs isn’t used to train their models by default; they may keep it for a limited time to check for abuse.</p>
          </>
        )}
        {web && <p className="text-s-ink-3">Web search is on, so your search terms also go to the search provider.</p>}
        <p className="text-s-ink-3">
          {user ? "Orbis saves this chat to your account" : "This chat is saved in this browser"}; attached files’ contents aren’t kept, only their names.
        </p>
        <p className="flex flex-wrap gap-x-3">
          <a href="/privacy" className="text-s-ink underline-offset-2 hover:underline">
            Privacy Policy
          </a>
          <button type="button" onClick={studio.openSettings} className="text-s-ink underline-offset-2 hover:underline">
            Privacy and data settings
          </button>
        </p>
      </div>
    </Menu>
  );
}
