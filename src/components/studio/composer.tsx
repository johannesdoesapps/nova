"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, CodeXml, FileText, Globe, ImagePlus, Mic, Paperclip, Plus, Scale, ShieldQuestionMark, Square, Telescope, X } from "lucide-react";
import type { ModelWithStatus } from "@/lib/ai/types";
import { CHAT_MODES, MODE_LABELS, type ChatMode } from "@/lib/ai/modes";
import { ALLOWED_ATTACHMENT_EXT, MAX_ATTACHMENT_CHARS } from "@/lib/limits";
import { cn } from "@/lib/utils";
import type { ChatAttachment } from "./chat-client";
import { IconButton, iconButtonClass, Menu, MenuItem, MenuLabel, MenuSeparator, Switch } from "./ui";
import { UsageNotice, useUsage } from "./usage";

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
      next.push({ name: f.name, content: text });
    }
    p.onAttachments(next);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = () => {
    if (speech.listening) speech.stop();
    if (canSend) p.onSubmit();
  };

  const model = p.models?.find((m) => m.id === p.modelId);
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

        <label htmlFor="studio-input" className="sr-only">Message NOVA</label>
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
          placeholder={speech.listening ? "Listening…" : (p.placeholder ?? (p.variant === "hero" ? "Ask anything…" : "Message NOVA"))}
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
              hint={filesAllowed ? "Text, Markdown, CSV or JSON · up to 3 files" : "Not enabled for this agent"}
              disabled={!filesAllowed}
              onClick={() => fileRef.current?.click()}
            >
              Upload files
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
                      ? "Needs SEARCH_API_KEY on the server"
                      : "Cite live sources in replies"}
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

          <div className="ml-auto flex items-center gap-1">
            <Menu
              label="Model"
              side="auto"
              align="end"
              width={300}
              disabled={!p.models}
              buttonLabel={`Model: ${model?.displayName ?? "loading"}`}
              buttonTitle="Choose model"
              buttonClassName="inline-flex h-9 max-w-[150px] items-center gap-1 rounded-full px-3 text-[13px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink disabled:opacity-50 sm:max-w-[220px]"
              button={
                <>
                  <span className="truncate">{model?.displayName ?? (p.models ? "Choose model" : "Loading…")}</span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                </>
              }
            >
                  <MenuLabel>Model</MenuLabel>
                  {p.models?.length === 0 && <p className="px-2.5 py-2 text-[13px] text-s-ink-3">No models are configured.</p>}
                  {p.models?.map((m) => (
                    <MenuItem
                      key={m.id}
                      role="menuitemradio"
                      checked={m.id === p.modelId}
                      disabled={!m.available}
                      hint={!m.available ? "Needs an API key on the server" : m.provider === "demo" ? "Simulated replies — no AI provider" : providerName(m.provider)}
                      right={m.id === p.modelId ? <Check /> : null}
                      onClick={() => p.onModel(m.id)}
                    >
                      {m.displayName}
                    </MenuItem>
                  ))}
            </Menu>

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
    </div>
  );
}

function providerName(p: string) {
  return p === "anthropic" ? "Anthropic" : p === "openai" ? "OpenAI" : p === "huggingface" ? "Hugging Face" : p;
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

function useSpeech(onText: (t: string) => void) {
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
