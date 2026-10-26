"use client";
import { useState } from "react";
import { Check, ThumbsDown, ThumbsUp } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import { FEEDBACK_RATINGS, RATING_LABELS, type EventName, type FeedbackFeature, type FeedbackRating } from "@/lib/analytics/events";
import { cn } from "@/lib/utils";

/** Save a rating for one result (signed in). */
export function sendFeedback(body: { feature: FeedbackFeature; subjectId: string; rating: FeedbackRating; comment?: string; modelId?: string }) {
  return jsonFetch("/api/feedback", { method: "POST", body: JSON.stringify(body) });
}

/**
 * Report one of the browser-side product events (signed in; ignored by the
 * server for guests and for anyone who turned events off). Never blocks, never
 * carries text.
 */
export function reportEvent(event: Extract<EventName, "useful_result" | "palette_command" | "comparison_started">, props: Record<string, string | number> = {}) {
  try {
    void fetch("/api/events", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event, props }), keepalive: true }).catch(() => {});
  } catch {
    /* not counted */
  }
}

const REASONS = FEEDBACK_RATINGS.filter((r) => r !== "helpful");

/**
 * The reasons a result wasn't right, offered only after someone says so:
 * pick one, optionally add a note, send. Nothing is asked unprompted.
 */
export function FeedbackReasons({ onSend, onCancel, className }: { onSend: (rating: FeedbackRating, comment?: string) => Promise<void>; onCancel: () => void; className?: string }) {
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [comment, setComment] = useState("");
  const [state, setState] = useState<{ status: "idle" | "sending" | "sent" } | { status: "error"; message: string }>({ status: "idle" });
  if (state.status === "sent")
    return (
      <p role="status" className={cn("flex items-center gap-1.5 text-[12.5px] text-s-ink-3", className)}>
        <Check className="h-3.5 w-3.5" /> Thanks, that helps us improve Orbis.
      </p>
    );
  return (
    <form
      className={cn("rounded-xl border border-s-line p-3 text-[13px]", className)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!rating) return;
        setState({ status: "sending" });
        try {
          await onSend(rating, comment.trim() || undefined);
          setState({ status: "sent" });
        } catch (err) {
          setState({ status: "error", message: (err as Error).message });
        }
      }}
    >
      <fieldset>
        <legend className="mb-2 text-s-ink-2">What wasn’t right?</legend>
        <div className="flex flex-wrap gap-1.5">
          {REASONS.map((r) => (
            <label
              key={r}
              className={cn(
                "cursor-pointer rounded-full border px-2.5 py-1 text-[12.5px] transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--s-ring)]",
                rating === r ? "border-s-line-strong bg-s-hover text-s-ink" : "border-s-line text-s-ink-2 hover:bg-s-hover",
              )}
            >
              <input type="radio" name="reason" value={r} checked={rating === r} onChange={() => setRating(r)} className="sr-only" />
              {RATING_LABELS[r]}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="mt-2.5 block text-[12px] text-s-ink-3">
        Anything to add? (optional; please leave out private details)
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          maxLength={1000}
          rows={2}
          className="mt-1 block w-full resize-y rounded-lg border border-s-line bg-transparent px-2.5 py-1.5 text-[13px] text-s-ink outline-none focus:border-s-line-strong"
        />
      </label>
      {state.status === "error" && (
        <p role="alert" className="mt-1.5 text-[12.5px] text-s-danger">
          {state.message}
        </p>
      )}
      <div className="mt-2.5 flex gap-2">
        <button type="submit" disabled={!rating || state.status === "sending"} className="h-8 rounded-lg bg-s-accent px-3 text-[12.5px] font-medium text-s-accent-ink disabled:opacity-40">
          {state.status === "sending" ? "Sending…" : "Send"}
        </button>
        <button type="button" onClick={onCancel} className="h-8 rounded-lg px-3 text-[12.5px] text-s-ink-2 hover:bg-s-hover">
          Cancel
        </button>
      </div>
      <p className="mt-2 text-[11.5px] text-s-ink-3">Your rating and note are saved with your account so we can find and fix problems. The result itself isn’t attached.</p>
    </form>
  );
}

/**
 * "Was this useful?" after a finished task (a template run, a check): one tap
 * for helpful; the reasons only if it wasn't. Signed-in users only.
 */
export function WasThisUseful({ feature, subjectId, modelId, className }: { feature: FeedbackFeature; subjectId: string; modelId?: string; className?: string }) {
  const [state, setState] = useState<"ask" | "reasons" | "thanks">("ask");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  if (state === "thanks")
    return (
      <p role="status" className={cn("flex items-center gap-1.5 text-[12.5px] text-s-ink-3", className)}>
        <Check className="h-3.5 w-3.5" /> Thanks for the feedback.
      </p>
    );
  if (state === "reasons")
    return (
      <FeedbackReasons className={className} onCancel={() => setState("ask")} onSend={(rating, comment) => sendFeedback({ feature, subjectId, rating, comment, modelId }).then(() => undefined)} />
    );
  return (
    <div className={cn("flex flex-wrap items-center gap-2 text-[12.5px] text-s-ink-3", className)}>
      <span>Was this useful?</span>
      <button
        type="button"
        disabled={sending}
        onClick={async () => {
          setError(null);
          setSending(true);
          try {
            await sendFeedback({ feature, subjectId, rating: "helpful", modelId });
            setState("thanks");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setSending(false);
          }
        }}
        className="inline-flex h-7 items-center gap-1 rounded-full border border-s-line px-2.5 text-s-ink-2 hover:bg-s-hover hover:text-s-ink disabled:opacity-50"
      >
        <ThumbsUp className="h-3.5 w-3.5" /> Yes
      </button>
      <button type="button" onClick={() => setState("reasons")} className="inline-flex h-7 items-center gap-1 rounded-full border border-s-line px-2.5 text-s-ink-2 hover:bg-s-hover hover:text-s-ink">
        <ThumbsDown className="h-3.5 w-3.5" /> Not quite
      </button>
      {error && (
        <span role="alert" className="text-s-danger">
          {error}
        </span>
      )}
    </div>
  );
}

const SAVED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rate a saved chat reply, or take the rating back (null). */
export function rateReply(feature: Extract<FeedbackFeature, "chat" | "agent">) {
  return async (m: { id: string }, rating: FeedbackRating | null, comment?: string) => {
    if (!SAVED_ID.test(m.id)) throw new Error("This reply hasn't been saved yet. Try again in a moment.");
    if (rating === null) await jsonFetch(`/api/feedback?feature=${feature}&subject=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    else await sendFeedback({ feature, subjectId: m.id, rating, comment });
  };
}
