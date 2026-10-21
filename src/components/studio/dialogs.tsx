"use client";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { Archive, ArchiveRestore, Bookmark, Check, FolderKanban, Monitor, Moon, Plus, Sun, Trash2 } from "lucide-react";
import { saveNote } from "@/components/projects/save-to-project";
import { jsonFetch } from "@/hooks/use-ndjson";
import { CHAT_MODES, MODE_LABELS, type ChatMode } from "@/lib/ai/modes";
import { REPLY_LENGTH_LABEL, REPLY_LENGTHS, REPLY_STYLE_LABEL, REPLY_STYLES, type ReplyLength, type ReplyStyle } from "@/lib/ai/reply-settings";
import { cn } from "@/lib/utils";
import type { ConvSummary, Msg } from "./history";
import type { SavedPrompt, StudioSettings, ThemePref } from "./prefs";
import { Dialog, IconButton, Kbd, Segmented, Switch } from "./ui";
import { UsageMeters, useUsage } from "./usage";
import { useApp } from "@/components/layout/app-context";
import { LEGAL } from "@/content/legal-meta";

const btn =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-xl px-3.5 text-[13.5px] font-medium transition active:scale-[0.98] disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4";
const btnPrimary = cn(btn, "bg-s-accent text-s-accent-ink hover:brightness-110");
const btnQuiet = cn(btn, "border border-s-line-strong hover:bg-s-hover");

/* Settings --------------------------------------------------------------- */

export function SettingsDialog({
  open,
  onClose,
  settings,
  onSettings,
  theme,
  historyKind,
  onClearLocal,
  onOpenArchived,
}: {
  open: boolean;
  onClose: () => void;
  settings: StudioSettings;
  onSettings: (s: Partial<StudioSettings>) => void;
  theme: { pref: ThemePref; setTheme: (p: ThemePref) => void };
  historyKind: "server" | "local";
  onClearLocal: () => void;
  onOpenArchived?: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Settings" width={520}>
      <SettingsBody settings={settings} onSettings={onSettings} theme={theme} historyKind={historyKind} onClearLocal={onClearLocal} onOpenArchived={onOpenArchived} />
    </Dialog>
  );
}

function SettingsBody({
  settings,
  onSettings,
  theme,
  historyKind,
  onClearLocal,
  onOpenArchived,
}: {
  settings: StudioSettings;
  onSettings: (s: Partial<StudioSettings>) => void;
  theme: { pref: ThemePref; setTheme: (p: ThemePref) => void };
  historyKind: "server" | "local";
  onClearLocal: () => void;
  onOpenArchived?: () => void;
}) {
  const [confirmClear, setConfirmClear] = useState(false);
  const usage = useUsage();
  const { integrations } = useApp();
  return (
    <>
      <div className="divide-y divide-s-line">
        {usage && (
          <div className="pb-2">
            <UsageMeters usage={usage} billing={integrations.billing} />
            <Link href="/usage" className="mt-2 inline-block text-[12.5px] text-s-ink-2 underline-offset-2 hover:text-s-ink hover:underline">
              Usage history and resets →
            </Link>
          </div>
        )}
        <Row title="Appearance" hint="Auto follows your system setting.">
          <Segmented
            label="Theme"
            value={theme.pref}
            onChange={theme.setTheme}
            options={[
              { value: "light", label: "Light", icon: <Sun /> },
              { value: "dark", label: "Dark", icon: <Moon /> },
              { value: "system", label: "Auto", icon: <Monitor /> },
            ]}
          />
        </Row>
        <Row title="Default mode" hint="Used for new chats.">
          <select
            value={settings.defaultMode}
            onChange={(e) => onSettings({ defaultMode: e.target.value as ChatMode })}
            className="h-9 rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px] text-s-ink outline-none"
            aria-label="Default mode"
          >
            {CHAT_MODES.map((m) => (
              <option key={m} value={m} className="bg-s-bg">
                {MODE_LABELS[m].label}
              </option>
            ))}
          </select>
        </Row>
        <Row title="Reply length" hint="Applies to new replies in chat.">
          <Segmented
            label="Reply length"
            value={settings.replyLength ?? "normal"}
            onChange={(v: ReplyLength) => onSettings({ replyLength: v })}
            options={REPLY_LENGTHS.map((v) => ({ value: v, label: REPLY_LENGTH_LABEL[v] }))}
          />
        </Row>
        <Row title="Reply style" hint="Precise sticks to established facts; Creative offers more ideas and alternatives.">
          <Segmented
            label="Reply style"
            value={settings.replyStyle ?? "balanced"}
            onChange={(v: ReplyStyle) => onSettings({ replyStyle: v })}
            options={REPLY_STYLES.map((v) => ({ value: v, label: REPLY_STYLE_LABEL[v] }))}
          />
        </Row>
        <Row title="Send with Enter" hint={settings.enterToSend ? "Shift + Enter adds a new line." : "Ctrl/⌘ + Enter sends; Enter adds a new line."}>
          <Switch label="Send with Enter" checked={settings.enterToSend} onChange={(v) => onSettings({ enterToSend: v })} />
        </Row>
        <Row
          title="Backup model"
          hint="If your model is down, a compatible one may answer, possibly from another provider. You'll always be told."
        >
          <Switch label="Backup model" checked={!!settings.allowFallback} onChange={(v) => onSettings({ allowFallback: v })} />
        </Row>
        <Row title="Chat history" hint={historyKind === "server" ? "Saved to your account." : "As a guest, chats are stored in this browser only."}>
          {historyKind === "local" ? (
            confirmClear ? (
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className={cn(btn, "bg-s-danger text-white hover:brightness-110")}
                  onClick={() => {
                    onClearLocal();
                    setConfirmClear(false);
                  }}
                >
                  Clear all
                </button>
                <button type="button" className={btnQuiet} onClick={() => setConfirmClear(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className={btnQuiet} onClick={() => setConfirmClear(true)}>
                <Trash2 /> Clear
              </button>
            )
          ) : (
            onOpenArchived ? (
              <button type="button" className={btnQuiet} onClick={onOpenArchived}>
                <Archive /> Archived chats
              </button>
            ) : (
              <span className="text-[13px] text-s-ink-3">Delete chats from the sidebar</span>
            )
          )}
        </Row>
        <PrivacyAndData signedIn={historyKind === "server"} onOpenArchived={onOpenArchived} />
        <div className="py-4">
          <div className="mb-2.5 text-[13.5px] font-medium">Keyboard shortcuts</div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-2 text-[13px] text-s-ink-2">
            <dt>Send message</dt>
            <dd>{settings.enterToSend ? <Kbd>Enter</Kbd> : <><Kbd>Ctrl/⌘</Kbd> <Kbd>Enter</Kbd></>}</dd>
            <dt>New line</dt>
            <dd>{settings.enterToSend ? <><Kbd>Shift</Kbd> <Kbd>Enter</Kbd></> : <Kbd>Enter</Kbd>}</dd>
            <dt>Search chats</dt>
            <dd><Kbd>Ctrl/⌘</Kbd> <Kbd>K</Kbd></dd>
            <dt>New chat</dt>
            <dd><Kbd>Ctrl/⌘</Kbd> <Kbd>Shift</Kbd> <Kbd>O</Kbd></dd>
            <dt>Toggle sidebar</dt>
            <dd><Kbd>Ctrl/⌘</Kbd> <Kbd>B</Kbd></dd>
          </dl>
        </div>
      </div>
    </>
  );
}

/** Every place your data lives in Orbis, what deleting or disconnecting does, and where to do it. */
function PrivacyAndData({ signedIn, onOpenArchived }: { signedIn: boolean; onOpenArchived?: () => void }) {
  const link = "text-s-ink underline-offset-2 hover:underline";
  const items: { title: string; text: React.ReactNode }[] = [
    {
      title: "Chats",
      text: signedIn ? (
        <>
          Delete a chat from its ⋯ menu in the sidebar: it’s removed from your account for good. Archiving hides it instead
          {onOpenArchived ? (
            <>
              {" "}
              (
              <button type="button" onClick={onOpenArchived} className={link}>
                archived chats
              </button>
              )
            </>
          ) : null}
          . Attached files aren’t kept, only their names.
        </>
      ) : (
        "As a guest, chats are kept in this browser only; Clear above removes them. Attached files aren’t kept, only their names."
      ),
    },
    {
      title: "Agents and memory",
      text: (
        <>
          Your <Link href="/agents" className={link}>agents</Link> keep the instructions you give them. Each code project’s Memory panel lists the notes its agent reads; edit or delete
          them there.
        </>
      ),
    },
    {
      title: "Connected apps",
      text: (
        <>
          <Link href="/connectors" className={link}>Connectors</Link> shows what each app can access. Make one read-only or disconnect it: Orbis deletes its copy of the sign-in and
          revokes access where the app allows.
        </>
      ),
    },
    {
      title: "Files and projects",
      text: (
        <>
          <Link href="/code" className={link}>Code projects</Link> keep their files, task history and attachments; deleting a project removes all of them. Download a copy first from the
          project’s menu.
        </>
      ),
    },
    { title: "On this device", text: "Saved prompts and display settings are kept in this browser only." },
    {
      title: "Your account",
      text: (
        <>
          For a copy of your data, or to delete your account and everything in it, email{" "}
          <a href={`mailto:${LEGAL.email}`} className={link}>
            {LEGAL.email}
          </a>
          . Visit counts use no cookies and never include what you type. Details are in the{" "}
          <a href="/privacy" className={link}>
            Privacy Policy
          </a>
          .
        </>
      ),
    },
  ];
  return (
    <div className="py-4">
      <div className="mb-2 text-[13.5px] font-medium">Privacy and data</div>
      <dl className="space-y-2.5 text-[12.5px] leading-relaxed">
        {items.map((i) => (
          <div key={i.title}>
            <dt className="font-medium text-s-ink-2">{i.title}</dt>
            <dd className="text-s-ink-3">{i.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-4 first:pt-1 sm:flex-nowrap">
      <div className="min-w-0 sm:max-w-[68%]">
        <div className="text-[13.5px] font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-[12.5px] text-s-ink-3">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/* Saved prompts ---------------------------------------------------------- */

export function PromptsDialog({
  open,
  onClose,
  prompts,
  onAdd,
  onRemove,
  onUse,
}: {
  open: boolean;
  onClose: () => void;
  prompts: SavedPrompt[];
  onAdd: (text: string) => boolean;
  onRemove: (id: string) => void;
  onUse: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<string | null>(null);
  return (
    <Dialog open={open} onClose={onClose} title="Saved prompts" description="Reusable prompts, kept in this browser." width={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!draft.trim()) return;
          if (onAdd(draft)) {
            setDraft("");
            setNote(null);
          } else setNote("That prompt is already saved.");
        }}
        className="mb-4"
      >
        <label htmlFor="new-prompt" className="sr-only">New prompt</label>
        <textarea
          id="new-prompt"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setNote(null);
          }}
          rows={2}
          maxLength={4000}
          placeholder="Write a prompt to reuse…"
          className="s-scroll block w-full resize-none rounded-2xl border border-s-line-strong bg-transparent px-3.5 py-2.5 text-[14px] text-s-ink outline-none transition placeholder:text-s-ink-3 focus:border-[color-mix(in_srgb,var(--s-accent)_45%,transparent)] focus-visible:outline-none"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-s-ink-3">{note ?? "Tip: save any of your messages with the bookmark icon."}</span>
          <button type="submit" className={btnPrimary} disabled={!draft.trim()}>
            <Plus /> Save
          </button>
        </div>
      </form>
      {prompts.length === 0 ? (
        <div className="grid place-items-center rounded-2xl border border-dashed border-s-line-strong px-6 py-10 text-center">
          <Bookmark className="h-5 w-5 text-s-ink-3" />
          <p className="mt-2 text-[13.5px] text-s-ink-2">No saved prompts yet.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {prompts.map((p) => (
            <li key={p.id} className="group flex items-start gap-2 rounded-2xl border border-s-line p-1.5 transition hover:border-s-line-strong">
              <button
                type="button"
                onClick={() => onUse(p.text)}
                className="min-w-0 flex-1 rounded-xl px-2.5 py-1.5 text-left text-[13.5px] leading-relaxed text-s-ink-2 transition hover:text-s-ink"
                title="Use this prompt"
              >
                <span className="line-clamp-3 whitespace-pre-wrap">{p.text}</span>
              </button>
              <IconButton size="sm" label="Delete prompt" onClick={() => onRemove(p.id)}>
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/* Delete confirmation ---------------------------------------------------- */

export function DeleteDialog({ conv, onClose, onConfirm }: { conv: ConvSummary | null; onClose: () => void; onConfirm: (c: ConvSummary) => Promise<void> }) {
  return (
    <Dialog open={!!conv} onClose={onClose} title="Delete chat?" description={conv ? `“${conv.title}” will be permanently deleted.` : undefined} width={420}>
      {conv && <DeleteBody key={conv.id} conv={conv} onClose={onClose} onConfirm={onConfirm} />}
    </Dialog>
  );
}

function DeleteBody({ conv, onClose, onConfirm }: { conv: ConvSummary; onClose: () => void; onConfirm: (c: ConvSummary) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error && <p role="alert" className="mb-3 text-[13px] text-s-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnQuiet} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          className={cn(btn, "bg-s-danger text-white hover:brightness-110")}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm(conv);
              onClose();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          Delete
        </button>
      </div>
    </>
  );
}

/* Archived chats ---------------------------------------------------------- */

export function ArchivedDialog({
  open,
  onClose,
  load,
  onRestore,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  load: () => Promise<ConvSummary[]>;
  onRestore: (c: ConvSummary) => Promise<void>;
  onDelete: (c: ConvSummary) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Archived chats" description="Archived chats are hidden from the sidebar. Restore one to see it there again." width={520}>
      {open && <ArchivedBody load={load} onRestore={onRestore} onDelete={onDelete} onClose={onClose} />}
    </Dialog>
  );
}

function ArchivedBody({ load, onRestore, onDelete, onClose }: { load: () => Promise<ConvSummary[]>; onRestore: (c: ConvSummary) => Promise<void>; onDelete: (c: ConvSummary) => void; onClose: () => void }) {
  const [list, setList] = useState<ConvSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    load()
      .then((l) => live && setList(l))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [load]);
  if (error) return <p role="alert" className="text-[13px] text-s-danger">{error}</p>;
  if (!list) return <div className="s-skeleton h-16 w-full rounded-xl" />;
  if (!list.length) return <p className="text-[13.5px] text-s-ink-3">No archived chats.</p>;
  return (
    <ul className="s-scroll max-h-[50vh] divide-y divide-s-line overflow-y-auto">
      {list.map((c) => (
        <li key={c.id} className="flex items-center gap-2 py-2">
          <Link href={`/chat?c=${c.id}`} onClick={onClose} className="min-w-0 flex-1 truncate text-[13.5px] text-s-ink hover:underline" title={c.title}>
            {c.title}
          </Link>
          <button
            type="button"
            className={btnQuiet}
            onClick={async () => {
              try {
                await onRestore(c);
                setList((l) => l?.filter((x) => x.id !== c.id) ?? null);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            <ArchiveRestore /> Restore
          </button>
          <IconButton label={`Delete ${c.title}`} size="sm" onClick={() => onDelete(c)}>
            <Trash2 />
          </IconButton>
        </li>
      ))}
    </ul>
  );
}

/* Generic confirmation ---------------------------------------------------- */

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} width={440}>
      {open && <ConfirmBody confirmLabel={confirmLabel} onClose={onClose} onConfirm={onConfirm} />}
    </Dialog>
  );
}

function ConfirmBody({ confirmLabel, onClose, onConfirm }: { confirmLabel: string; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      {error && <p role="alert" className="mb-3 text-[13px] text-s-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" className={btnQuiet} onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          className={cn(btn, "bg-s-danger text-white hover:brightness-110")}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {busy ? "Deleting…" : confirmLabel}
        </button>
      </div>
    </>
  );
}

/* Save to project (signed-in users) -------------------------------------- */

/* Projects: pick one ----------------------------------------------------- */

type ProjectRef = { id: string; name: string };

/**
 * Choose one of the user's projects (or create one) and do something with it.
 * `onPick` returns the confirmation to show; it throws to show an error.
 */
export function ProjectPickerDialog({
  open,
  title,
  description,
  createLabel,
  onPick,
  onClose,
  current,
  onRemove,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  /** The button beside the new-project box, e.g. "Create & save". */
  createLabel: string;
  onPick: (p: ProjectRef) => Promise<string>;
  onClose: () => void;
  /** The project it is already in, marked in the list. */
  current?: string | null;
  /** Shown when `current` is set: take it out of that project. */
  onRemove?: () => Promise<string>;
  /** Extra fields above the list. */
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} width={440}>
      {open && (
        <PickerBody createLabel={createLabel} onPick={onPick} onClose={onClose} current={current} onRemove={onRemove}>
          {children}
        </PickerBody>
      )}
    </Dialog>
  );
}

function PickerBody({
  createLabel,
  onPick,
  onClose,
  current,
  onRemove,
  children,
}: {
  createLabel: string;
  onPick: (p: ProjectRef) => Promise<string>;
  onClose: () => void;
  current?: string | null;
  onRemove?: () => Promise<string>;
  children?: ReactNode;
}) {
  const [projects, setProjects] = useState<ProjectRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; project: ProjectRef | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    jsonFetch<{ projects: ProjectRef[] }>("/api/projects")
      .then((r) => setProjects(r.projects))
      .catch((e: Error) => setError(e.message));
  }, []);

  const run = async (key: string, fn: () => Promise<string>, project: ProjectRef | null) => {
    setBusy(key);
    setError(null);
    try {
      setDone({ text: await fn(), project });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (done) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <span className="s-pop grid h-10 w-10 place-items-center rounded-full bg-s-accent-soft text-s-accent">
          <Check className="h-5 w-5" />
        </span>
        <p className="mt-3 text-[14px]">{done.text}</p>
        <div className="mt-4 flex gap-2">
          {done.project && (
            <Link href={`/missions/${done.project.id}`} onClick={onClose} className={btnQuiet}>
              Open project
            </Link>
          )}
          <button type="button" onClick={onClose} className={btnPrimary}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      {children}
      {error && (
        <p role="alert" className="mb-3 text-[13px] text-s-danger">
          {error}
        </p>
      )}
      {projects === null && !error ? (
        <div className="space-y-2" aria-label="Loading projects">
          {[0, 1, 2].map((i) => (
            <div key={i} className="s-skeleton h-10" />
          ))}
        </div>
      ) : (
        <ul className="s-scroll flex max-h-64 flex-col gap-1 overflow-y-auto">
          {projects?.length === 0 && <li className="px-1 py-2 text-[13.5px] text-s-ink-3">No projects yet. Create one below.</li>}
          {projects?.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                disabled={!!busy || p.id === current}
                onClick={() => void run(p.id, () => onPick(p), p)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13.5px] transition hover:bg-s-hover disabled:opacity-50"
              >
                <FolderKanban className="h-4 w-4 text-s-ink-3" />
                <span className="truncate">{p.name}</span>
                {p.id === current && <span className="ml-auto text-[12px] text-s-ink-3">Current</span>}
                {busy === p.id && <span className="ml-auto text-[12px] text-s-ink-3">Saving…</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && onRemove && (
        <button type="button" disabled={!!busy} onClick={() => void run("remove", onRemove, null)} className="mt-2 px-3 text-[12.5px] text-s-ink-3 underline-offset-4 hover:text-s-ink hover:underline disabled:opacity-50">
          Take it out of its project
        </button>
      )}
      <form
        className="mt-4 flex gap-2 border-t border-s-line pt-4"
        onSubmit={async (e) => {
          e.preventDefault();
          const n = name.trim();
          if (!n) return;
          setBusy("new");
          setError(null);
          try {
            const r = await jsonFetch<{ project: ProjectRef }>("/api/projects", { method: "POST", body: JSON.stringify({ name: n }) });
            setName("");
            setProjects((list) => [r.project, ...(list ?? [])]);
            await run(r.project.id, () => onPick(r.project), r.project);
          } catch (err) {
            setError((err as Error).message);
            setBusy(null);
          }
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New project name"
          aria-label="New project name"
          maxLength={120}
          className="h-9 min-w-0 flex-1 rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px] text-s-ink outline-none placeholder:text-s-ink-3 focus-visible:outline-none"
        />
        <button type="submit" className={btnPrimary} disabled={!name.trim() || !!busy}>
          {createLabel}
        </button>
      </form>
    </>
  );
}

/** A short title from the start of a reply. */
export function titleFromReply(content: string, max = 80): string {
  return content.replace(/[#*`>_\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || "Saved answer";
}

export function SaveToProjectDialog({ message, onClose }: { message: Msg | null; onClose: () => void }) {
  return (
    <ProjectPickerDialog
      open={!!message}
      onClose={onClose}
      title="Save as a note"
      description="Adds this reply to a project's notes. Notes stay in that project."
      createLabel="Create & save"
      onPick={async (p) => {
        await saveNote(p.id, { title: titleFromReply(message!.content), content: message!.content, sourceType: "chat", sourceRef: message!.id });
        return `Saved to ${p.name}.`;
      }}
    />
  );
}

/** Turn a reply into a project task, or start a milestone with it. The reply becomes the task's details. */
export function AddTaskDialog({ message, kind, onClose }: { message: Msg | null; kind: "task" | "milestone"; onClose: () => void }) {
  const [seen, setSeen] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [milestone, setMilestone] = useState("");
  // A new reply starts with fresh fields.
  if (message && `${kind}:${message.id}` !== seen) {
    setSeen(`${kind}:${message.id}`);
    setTitle(titleFromReply(message.content));
    setMilestone(kind === "milestone" ? titleFromReply(message.content, 120) : "");
  }
  const field = "mt-1 h-9 w-full rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px] text-s-ink outline-none placeholder:text-s-ink-3 focus-visible:outline-none";
  return (
    <ProjectPickerDialog
      open={!!message}
      onClose={onClose}
      title={kind === "task" ? "Add as a task" : "Add as a milestone"}
      description={kind === "task" ? "Adds a task to a project, with this reply as its details." : "Starts a milestone in a project, with this reply as its first task."}
      createLabel="Create & add"
      onPick={async (p) => {
        const t = title.trim();
        const m = milestone.trim();
        if (!t) throw new Error("Give the task a title.");
        if (kind === "milestone" && !m) throw new Error("Give the milestone a name.");
        const content = message!.content.trim();
        const description = content.length > 4000 ? `${content.slice(0, 3999)}…` : content;
        await jsonFetch(`/api/missions/${p.id}/tasks`, { method: "POST", body: JSON.stringify({ title: t.slice(0, 200), description, milestone: m ? m.slice(0, 120) : null }) });
        return kind === "task" ? `Task added to ${p.name}.` : `Milestone added to ${p.name}.`;
      }}
    >
      <div className="mb-4 grid gap-3">
        <label className="text-[12.5px] text-s-ink-2">
          Task
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} className={field} />
        </label>
        <label className="text-[12.5px] text-s-ink-2">
          {kind === "task" ? "Milestone (optional)" : "Milestone"}
          <input value={milestone} onChange={(e) => setMilestone(e.target.value)} maxLength={120} placeholder={kind === "task" ? "e.g. Launch" : undefined} className={field} />
        </label>
        <p className="text-[12px] text-s-ink-3">Then choose the project:</p>
      </div>
    </ProjectPickerDialog>
  );
}

/** Move a chat into a project, or take it out of one. */
export function MoveChatDialog({ conv, onClose, onMove }: { conv: ConvSummary | null; onClose: () => void; onMove: (c: ConvSummary, projectId: string | null) => Promise<void> }) {
  return (
    <ProjectPickerDialog
      open={!!conv}
      onClose={onClose}
      title="Move to project"
      description="The chat will be listed in the project. Its replies can use that project's instructions, never another project's."
      createLabel="Create & move"
      current={conv?.project_id ?? null}
      onPick={async (p) => {
        await onMove(conv!, p.id);
        return `Moved to ${p.name}.`;
      }}
      onRemove={async () => {
        await onMove(conv!, null);
        return "Taken out of its project.";
      }}
    />
  );
}
