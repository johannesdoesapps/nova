"use client";
import { memo, useState, type ReactNode } from "react";
import { BookmarkPlus, ChartColumn, Check, ChevronRight, CircleAlert, CircleCheck, Copy, Ellipsis, FileText, Flag, FolderPlus, Globe, MessageSquarePlus, Pencil, RefreshCw, Sparkles, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { Markdown } from "@/components/common/markdown";
import { ActionCard } from "@/components/connectors/action-card";
import { BrandIcon } from "@/components/connectors/brand-icon";
import { cn, formatUsd } from "@/lib/utils";
import type { Msg } from "./history";
import type { Feedback } from "./prefs";
import { IconButton, iconButtonClass, Menu, MenuItem, MenuSeparator, OrbisMark } from "./ui";

/** What a reply can be turned into. Project ones need an account. */
export type ReplyAction = "note" | "task" | "milestone" | "prompt" | "followup";
import { useVerify, VerifyButton, VerifyPanel } from "./verify-panel";

export const MessageView = memo(function MessageView({
  m,
  isLast,
  busy,
  feedback,
  thinkingLabel,
  onRetry,
  onEdit,
  onFeedback,
  onSavePrompt,
  onReplyAction,
  projectActions,
  assistantName,
  assistantAvatar,
  question = "",
}: {
  m: Msg;
  isLast: boolean;
  busy: boolean;
  feedback?: Feedback;
  thinkingLabel: string;
  onRetry: (id: string) => void;
  onEdit?: (id: string, text: string) => void;
  onFeedback: (id: string, f: Feedback) => void;
  onSavePrompt: (text: string) => boolean;
  /** Turn a reply into a note, task, milestone, saved prompt or follow-up chat. */
  onReplyAction?: (action: ReplyAction, m: Msg) => void;
  /** Whether the project actions (note, task, milestone) are offered. */
  projectActions?: boolean;
  /** Agent conversations show the agent's own name and avatar. */
  assistantName?: string;
  assistantAvatar?: ReactNode;
  /** The user message this reply answers; used by the Truth Layer. */
  question?: string;
}) {
  const verify = useVerify(question, m.content);
  if (m.role === "user") {
    return <UserMessage m={m} busy={busy} onEdit={onEdit} onSavePrompt={onSavePrompt} />;
  }
  return <AssistantMessage {...{ m, isLast, busy, feedback, thinkingLabel, onRetry, onFeedback, onReplyAction, projectActions, assistantName, assistantAvatar, verify }} />;
});

/** A question you sent, with copy, save and (in the general chat) edit. */
function UserMessage({ m, busy, onEdit, onSavePrompt }: { m: Msg; busy: boolean; onEdit?: (id: string, text: string) => void; onSavePrompt: (text: string) => boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  if (editing) {
    const submit = () => {
      const t = draft.trim();
      if (!t || busy) return;
      setEditing(false);
      onEdit?.(m.id, t);
    };
    return (
      <div className="s-in flex flex-col items-end">
        <div className="w-full max-w-[88%] rounded-[22px] border border-s-line-strong bg-s-user p-2 sm:max-w-[78%]">
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            rows={Math.min(10, Math.max(2, draft.split("\n").length))}
            maxLength={12000}
            aria-label="Edit your message"
            className="block w-full resize-y bg-transparent px-2 py-1 text-[15.5px] leading-relaxed outline-none"
          />
          <div className="flex items-center justify-end gap-1.5 px-1 pt-1">
            <span className="mr-auto pl-1 text-[12px] text-s-ink-3">Replaces this message and everything after it.</span>
            <button type="button" onClick={() => setEditing(false)} className="h-8 rounded-full px-3 text-[13px] text-s-ink-2 hover:bg-s-hover">
              Cancel
            </button>
            <button type="button" onClick={submit} disabled={!draft.trim() || busy} className="h-8 rounded-full bg-s-accent px-3.5 text-[13px] font-medium text-s-accent-ink disabled:opacity-40">
              Send
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
      <div className="group/msg s-in flex flex-col items-end">
        {m.attachments && m.attachments.length > 0 && (
          <div className="mb-1.5 flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {m.attachments.map((a) => (
              <span key={a} className="inline-flex items-center gap-1.5 rounded-xl border border-s-line px-2.5 py-1 text-[12px] text-s-ink-2">
                <FileText className="h-3.5 w-3.5" /> {a}
              </span>
            ))}
          </div>
        )}
        <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-[22px] rounded-br-lg bg-s-user px-4 py-2.5 text-[15.5px] leading-relaxed sm:max-w-[78%]">
          {m.content}
        </div>
        <div className="s-actions mt-1 flex items-center gap-0.5">
          <CopyAction text={m.content} />
          {onEdit && (
            <IconButton
              size="sm"
              label="Edit"
              disabled={busy}
              onClick={() => {
                setDraft(m.content);
                setEditing(true);
              }}
            >
              <Pencil />
            </IconButton>
          )}
          <SavePromptAction onSave={() => onSavePrompt(m.content)} />
        </div>
      </div>
    );
}

function AssistantMessage({
  m,
  isLast,
  busy,
  feedback,
  thinkingLabel,
  onRetry,
  onFeedback,
  onReplyAction,
  projectActions,
  assistantName,
  assistantAvatar,
  verify,
}: {
  m: Msg;
  isLast: boolean;
  busy: boolean;
  feedback?: Feedback;
  thinkingLabel: string;
  onRetry: (id: string) => void;
  onFeedback: (id: string, f: Feedback) => void;
  onReplyAction?: (action: ReplyAction, m: Msg) => void;
  projectActions?: boolean;
  assistantName?: string;
  assistantAvatar?: ReactNode;
  verify: ReturnType<typeof useVerify>;
}) {
  const streaming = m.status === "streaming";
  const valid = new Set((m.sources ?? []).map((s) => s.index));
  // A proposed connector action arrives as a block at the end of the reply; it becomes a review card, not text.
  const shown = streaming ? m.content.replace(/```orbis-action[\s\S]*$/, "").trimEnd() : m.content;
  return (
    <div className="group/msg s-in">
      <div className="mb-2.5 flex items-center gap-2 text-[12.5px] text-s-ink-3">
        {assistantAvatar ?? <OrbisMark className="h-[18px] w-[18px] text-s-ink" />}
        <span className="font-medium text-s-ink-2">{assistantName ?? m.modelName ?? "Orbis"}</span>
        {assistantName && m.modelName && <span className="hidden sm:inline">· {m.modelName}</span>}
        {m.routing && (
          <span title={m.routing} className="inline-flex items-center gap-1 rounded-full bg-s-accent-soft px-2 py-px text-[11px] text-s-accent">
            <Sparkles className="h-3 w-3" /> Auto
          </span>
        )}
        {m.simulated && (
          <span className="rounded-full border border-s-line-strong px-2 py-px text-[11px]" title="No AI provider is configured; this reply is a template.">
            Simulated
          </span>
        )}
      </div>

      {m.notices?.map((n, i) => (
        <p key={i} className="mb-3 flex items-start gap-2 rounded-2xl border border-s-line px-3.5 py-2.5 text-[13.5px] text-s-ink-2">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {n}
        </p>
      ))}

      {m.tools?.map((t, i) => <ToolRow key={i} tool={t} />)}

      {shown ? (
        <div className={cn(streaming && "s-caret")}>
          <Markdown
            text={shown}
            className="s-prose"
            runnable={!streaming}
            validCitations={valid}
            onCitation={(n) => {
              const s = m.sources?.find((x) => x.index === n);
              if (s?.url) window.open(s.url, "_blank", "noopener,noreferrer");
            }}
          />
        </div>
      ) : streaming ? (
        <div role="status" className="flex h-7 items-center gap-3">
          <span className="flex gap-1" aria-hidden>
            <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-accent" />
            <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-accent [animation-delay:160ms]" />
            <span className="s-dot h-1.5 w-1.5 rounded-full bg-s-accent [animation-delay:320ms]" />
          </span>
          <span className="s-shimmer text-[14px]">{thinkingLabel}</span>
        </div>
      ) : null}

      {m.sources && m.sources.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {m.sources.map((s) => {
            const label = (
              <>
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-s-accent-soft px-1 text-[11px] font-semibold text-s-accent">{s.index}</span>
                <span className="truncate">{s.app ? `${s.app} · ${s.title}` : (s.domain ?? s.title)}</span>
              </>
            );
            const cls = "glass inline-flex max-w-[260px] items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12px] text-s-ink-2 transition hover:text-s-ink";
            return s.url ? (
              <a key={s.index} href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.title} className={cls}>
                {label}
              </a>
            ) : (
              <span key={s.index} title={s.title} className={cls}>
                {label}
              </span>
            );
          })}
        </div>
      )}

      {!streaming && m.actions?.map((a) => <ActionCard key={a.id} action={a} messageId={m.id} />)}

      {m.status === "error" && (
        <div role="alert" className="s-in mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-s-line bg-s-hover px-4 py-3 text-[14px]">
          <CircleAlert className="h-4 w-4 shrink-0 text-s-danger" />
          <span className="min-w-0 flex-1 text-s-ink-2">{m.error ?? "Something went wrong."}</span>
          {m.needsSignIn ? (
            // Retrying can't help a visitor: offer the way in instead, coming back to this chat.
            <span className="flex gap-2">
              <a href="/login?mode=signup&next=%2Fchat" className="inline-flex items-center rounded-full bg-s-accent px-3 py-1 text-[13px] font-medium text-s-accent-ink transition hover:brightness-110">
                Create a free account
              </a>
              <a href="/login?next=%2Fchat" className="inline-flex items-center rounded-full border border-s-line-strong px-3 py-1 text-[13px] transition hover:bg-s-hover">
                Sign in
              </a>
            </span>
          ) : (
            isLast && (
              <button
                type="button"
                onClick={() => onRetry(m.id)}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-full border border-s-line-strong px-3 py-1 text-[13px] transition hover:bg-s-hover disabled:opacity-40"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Try again
              </button>
            )
          )}
        </div>
      )}

      {m.status === "done" && m.content && (
        <div className="s-actions mt-3 flex items-center gap-0.5" data-pinned={isLast}>
          <CopyAction text={m.content} />
          {/* Only the latest reply can be regenerated in place. */}
          {isLast && (
            <IconButton size="sm" label="Regenerate" onClick={() => onRetry(m.id)} disabled={busy}>
              <RefreshCw />
            </IconButton>
          )}
          <IconButton
            size="sm"
            label="Good response"
            aria-pressed={feedback === "up"}
            onClick={() => onFeedback(m.id, "up")}
            className={cn(feedback === "up" && "text-s-accent hover:text-s-accent")}
          >
            <ThumbsUp className={cn(feedback === "up" && "fill-current")} />
          </IconButton>
          <IconButton
            size="sm"
            label="Bad response"
            aria-pressed={feedback === "down"}
            onClick={() => onFeedback(m.id, "down")}
            className={cn(feedback === "down" && "text-s-accent hover:text-s-accent")}
          >
            <ThumbsDown className={cn(feedback === "down" && "fill-current")} />
          </IconButton>
          {!m.simulated && <VerifyButton loading={verify.state.status === "loading"} onClick={verify.run} />}
          {onReplyAction && (
            <Menu label="Turn this reply into…" side="auto" width={240} buttonLabel="More actions" buttonTitle="Save or reuse this reply" buttonClassName={iconButtonClass("sm")} button={<Ellipsis />}>
              {projectActions && (
                <>
                  <MenuItem icon={<FolderPlus />} hint="Into a project's notes" onClick={() => onReplyAction("note", m)}>
                    Save as note
                  </MenuItem>
                  <MenuItem icon={<CircleCheck />} hint="A project task, with this reply as details" onClick={() => onReplyAction("task", m)}>
                    Add as task
                  </MenuItem>
                  <MenuItem icon={<Flag />} hint="Start a milestone in a project" onClick={() => onReplyAction("milestone", m)}>
                    Add as milestone
                  </MenuItem>
                  <MenuSeparator />
                </>
              )}
              <MenuItem icon={<BookmarkPlus />} hint="Reuse it from Saved prompts" onClick={() => onReplyAction("prompt", m)}>
                Save as prompt
              </MenuItem>
              <MenuItem icon={<MessageSquarePlus />} hint="A new chat that quotes this reply" onClick={() => onReplyAction("followup", m)}>
                Follow up in new chat
              </MenuItem>
            </Menu>
          )}
          {typeof m.cost === "number" && m.cost > 0 && <span className="ml-2 text-[11.5px] text-s-ink-3">≈ {formatUsd(m.cost)}</span>}
        </div>
      )}
      {m.status === "done" && <VerifyPanel state={verify.state} onClose={verify.close} onRetry={verify.run} onOpenFull={verify.openFull} />}
    </div>
  );
}

const TOOL_ICONS: Record<string, ReactNode> = { web_search: <Globe />, data_analysis: <ChartColumn /> };

/** A tool the server ran for this reply; expandable when it produced output. */
function ToolRow({ tool }: { tool: NonNullable<Msg["tools"]>[number] }) {
  const [open, setOpen] = useState(false);
  const icon = tool.name.startsWith("connector:") ? <BrandIcon id={tool.name.slice(10)} size={24} className="rounded-lg" /> : (TOOL_ICONS[tool.name] ?? <Wrench />);
  const body = (
    <>
      <span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-lg [&_svg]:h-3.5 [&_svg]:w-3.5", tool.status === "ok" ? "bg-s-accent-soft text-s-accent" : "bg-s-hover text-s-danger")}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{tool.label}</span>
      {tool.detail && <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")} />}
    </>
  );
  return (
    <div className="s-in mb-3 overflow-hidden rounded-2xl border border-s-line text-[13px] text-s-ink-2">
      {tool.detail ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left transition hover:bg-s-hover">
          {body}
        </button>
      ) : (
        <div className="flex items-center gap-2.5 px-2.5 py-2">{body}</div>
      )}
      {open && tool.detail && (
        <pre className="s-scroll s-fade max-h-64 overflow-auto border-t border-s-line bg-[var(--s-code)] px-3.5 py-3 font-mono text-[12px] leading-relaxed text-s-ink-2">{tool.detail}</pre>
      )}
    </div>
  );
}

function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      size="sm"
      label={done ? "Copied" : "Copy"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {done ? <Check className="s-pop text-s-accent" /> : <Copy />}
    </IconButton>
  );
}

function SavePromptAction({ onSave }: { onSave: () => boolean }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      size="sm"
      label={done ? "Saved to prompts" : "Save as prompt"}
      onClick={() => {
        onSave();
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
    >
      {done ? <Check className="s-pop text-s-accent" /> : <BookmarkPlus />}
    </IconButton>
  );
}
