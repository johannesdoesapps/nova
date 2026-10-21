"use client";
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { ArrowUp, CircleStop, Loader2, Mic } from "lucide-react";
import { iconButtonClass } from "@/components/studio/ui";
import { useSpeech } from "@/components/studio/composer";
import { cn } from "@/lib/utils";
import { AttachmentTray, Dragging, dropAndPaste, PlusMenu, type Attachments } from "./attachments";

/**
 * The coding prompt bar: + (attachments), the box, Stop or Send, and voice
 * input in one rounded bar, with small controls underneath (left and right).
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
    if (speech.listening) speech.stop();
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
      <div className="rounded-[18px] border border-s-line bg-s-glass-strong shadow-[var(--s-shadow-sm)] transition-colors focus-within:border-s-line-strong">
        {attachments && attachments.items.length + (attachments.notice ? 1 : 0) > 0 && (
          <div className="px-2 pt-2">
            <AttachmentTray attachments={attachments} />
          </div>
        )}
        <div className="flex items-end gap-0.5 p-1.5">
          {attachments && <PlusMenu attachments={attachments} disabled={sending || disabled} bare />}
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <textarea
            id={id}
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
            placeholder={placeholder}
            className="min-h-9 flex-1 resize-none bg-transparent px-1.5 py-[7px] text-[15px] leading-[22px] text-s-ink outline-none placeholder:text-s-ink-3 disabled:opacity-60"
          />
          {onStop && (
            <button type="button" onClick={onStop} aria-label="Stop the agent" title="Stop the agent" className={cn(iconButtonClass(), "h-9 w-9 text-s-ink hover:text-s-danger")}>
              <CircleStop />
            </button>
          )}
          {value.trim() && (
            <button
              type="submit"
              disabled={!canSend}
              aria-label="Send"
              title={waiting ? "Waiting for attachments to finish uploading" : "Send (Enter)"}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-s-accent text-s-accent-ink transition hover:brightness-110 disabled:opacity-40"
            >
              {sending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUp className="h-4 w-4" aria-hidden />}
            </button>
          )}
          {speech.supported && (
            <button
              type="button"
              onClick={() => (speech.listening ? speech.stop() : speech.start(value))}
              aria-label={speech.listening ? "Stop voice input" : "Voice input"}
              aria-pressed={speech.listening}
              title={speech.listening ? "Stop voice input" : "Voice input"}
              disabled={disabled}
              className={cn(iconButtonClass(), "h-9 w-9", speech.listening && "text-s-accent")}
            >
              <Mic className={cn(speech.listening && "animate-pulse")} />
            </button>
          )}
        </div>
      </div>
      {speech.error && (
        <p role="alert" className="mt-1 px-3 text-[12px] text-s-danger">
          {speech.error}
        </p>
      )}
      {(footerLeft || footerRight || working) && (
        <div className="mt-1 flex min-h-8 items-center gap-2 px-1.5 text-[12.5px] text-s-ink-3">
          <div className="flex min-w-0 items-center gap-1">{footerLeft}</div>
          <div className="ml-auto flex min-w-0 items-center gap-1">
            {footerRight}
            {working && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-s-accent" aria-label="Working" />}
          </div>
        </div>
      )}
    </form>
  );
}
