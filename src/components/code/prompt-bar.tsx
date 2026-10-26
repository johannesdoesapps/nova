"use client";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowUp, Loader2, Mic, Square } from "lucide-react";
import { iconButtonClass } from "@/components/studio/ui";
import { useSpeech } from "@/hooks/use-speech";
import { cn } from "@/lib/utils";
import { AttachmentTray, Dragging, dropAndPaste, PlusMenu, type Attachments } from "./attachments";

/**
 * The coding prompt bar, shaped like the chat box: the text on top, and one
 * row underneath with + (attachments), the left controls, then the right
 * controls (the model), voice input, and Stop or Send.
 * Enter sends, Shift+Enter starts a new line.
 */
export function PromptBar({
  id,
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  attachments,
  sending,
  disabled,
  onStop,
  footerLeft,
  footerRight,
  working,
  inputRef,
  maxLength = 8000,
}: {
  id: string;
  /** Read by screen readers (the bar has no visible label). */
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (text: string) => void;
  placeholder: string;
  attachments?: Attachments;
  /** A send is in progress. */
  sending?: boolean;
  disabled?: boolean;
  /** Shown as the Stop button while the agent is working. */
  onStop?: () => void;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  /** Shows the small working spinner at the bottom right. */
  working?: boolean;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  maxLength?: number;
}) {
  const own = useRef<HTMLTextAreaElement>(null);
  const box = inputRef ?? own;
  const [dragging, setDragging] = useState(false);
  const speech = useSpeech(onChange);
  const waiting = !!attachments?.busy;
  const canSend = !!value.trim() && !sending && !disabled && !waiting;

  // The box grows with its text, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value, box]);

  const send = () => {
    if (!canSend) return;
    // cancel, not stop: stop() delivers one last result, which would put the sent text back in the box.
    if (speech.listening) speech.cancel();
    onSubmit(value.trim());
  };

  return (
    <form
      className="relative"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
      {...(attachments ? dropAndPaste(attachments, setDragging) : {})}
    >
      {attachments && <Dragging show={dragging} />}
      {/* Same shape as the chat box: the text on top, the controls in one row underneath. */}
      <div className="composer glass-strong glass-edge rounded-[26px] p-2">
        {attachments && attachments.items.length + (attachments.notice ? 1 : 0) > 0 && (
          <div className="px-1 pb-1 pt-0.5">
            <AttachmentTray attachments={attachments} />
          </div>
        )}
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <textarea
          id={id}
          data-composer
          ref={box}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          rows={1}
          maxLength={maxLength}
          disabled={disabled}
          placeholder={speech.listening ? "Listening…" : placeholder}
          className="s-scroll block min-h-[56px] w-full resize-none bg-transparent px-3 pb-2 pt-3 text-[16px] leading-relaxed text-s-ink outline-none placeholder:text-s-ink-3 focus-visible:outline-none disabled:opacity-60"
        />
        <div className="flex items-center gap-1 pt-1">
          {attachments && <PlusMenu attachments={attachments} disabled={sending || disabled} bare />}
          {footerLeft && <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden whitespace-nowrap text-[13px] text-s-ink-2">{footerLeft}</div>}
          {/* The model name gives way on narrow screens so Send always fits. */}
          <div className="ml-auto flex min-w-0 items-center gap-1 [&>*]:shrink-0">
            {working && <Loader2 className="h-4 w-4 animate-spin text-s-accent" aria-label="Working" />}
            {footerRight && <div className="flex min-w-0 !shrink items-center gap-1">{footerRight}</div>}
            {speech.supported && (
              <button
                type="button"
                onClick={() => (speech.listening ? speech.stop() : speech.start(value))}
                aria-label={speech.listening ? "Stop voice input" : "Voice input"}
                aria-pressed={speech.listening}
                title={speech.listening ? "Stop voice input" : "Voice input"}
                disabled={disabled}
                className={cn(iconButtonClass(), "rounded-full", speech.listening && "bg-s-accent-soft text-s-accent")}
              >
                <Mic className={cn(speech.listening && "animate-pulse")} />
              </button>
            )}
            {onStop && (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop the agent"
                title="Stop the agent"
                className="s-pop grid h-9 w-9 place-items-center rounded-full bg-s-ink text-s-bg transition hover:opacity-85 active:scale-95"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </button>
            )}
            {(!onStop || value.trim()) && (
              <button
                type="submit"
                disabled={!canSend}
                aria-label="Send"
                title={waiting ? "Waiting for attachments to finish uploading" : "Send (Enter)"}
                className={cn(
                  "grid h-9 w-9 place-items-center rounded-full transition-all duration-200 active:scale-90",
                  canSend ? "bg-s-accent text-s-accent-ink shadow-[0_6px_18px_-6px_var(--s-accent)] hover:-translate-y-px hover:brightness-110" : "bg-s-hover text-s-ink-3",
                )}
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.2} aria-hidden />}
              </button>
            )}
          </div>
        </div>
      </div>
      {speech.error && (
        <p role="alert" className="mt-1 px-3 text-[12px] text-s-danger">
          {speech.error}
        </p>
      )}
    </form>
  );
}
