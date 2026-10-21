"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
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
        {historyKind === "server" && <DeleteAccount />}
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

/** Delete the account for good: a warning, then the user types their email address to confirm. */
function DeleteAccount() {
  const { user } = useApp();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = !!user?.email && email.trim().toLowerCase() === user.email.toLowerCase();
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await jsonFetch("/api/account/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: email.trim() }) });
      router.replace("/");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  if (!open)
    return (
      <Row title="Delete account" hint="Removes your account and everything in it, for good.">
        <button type="button" className={cn(btnQuiet, "text-s-danger")} onClick={() => setOpen(true)}>
          <Trash2 /> Delete…
        </button>
      </Row>
    );
  return (
    <div className="py-4">
      <div className="text-[13.5px] font-medium text-s-danger">Delete your account?</div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-s-ink-2">
        This permanently deletes your chats, agents, code projects and their files, missions, connected accounts and settings. It can&apos;t be undone. Download anything you want to keep first.
      </p>
      <label htmlFor="delete-email" className="mt-3 block text-[12.5px] text-s-ink-3">
        Type <span className="font-medium text-s-ink">{user?.email}</span> to confirm
      </label>
      <input
        id="delete-email"
        type="email"
        autoComplete="off"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mt-1.5 h-9 w-full rounded-xl border border-s-line-strong bg-transparent px-3 text-[13.5px] text-s-ink outline-none focus:border-s-danger"
      />
      {error && (
        <p role="alert" className="mt-2 text-[12.5px] text-s-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex gap-1.5">
        <button type="button" disabled={!matches || busy} className={cn(btn, "bg-s-danger text-white hover:brightness-110")} onClick={() => void remove()}>
          {busy ? "Deleting…" : "Delete my account"}
        </button>
        <button
          type="button"
          className={btnQuiet}
          onClick={() => {
            setOpen(false);
            setEmail("");
            setError(null);
          }}
        >
          Cancel
        </button>
      </div>
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

export function SaveToProjectDialog({ message, onClose }: { message: Msg | null; onClose: () => void }) {
  return (
    <Dialog open={!!message} onClose={onClose} title="Save to project" description="Adds this reply as a note in a research project." width={440}>
      {message && <SaveBody key={message.id} message={message} onClose={onClose} />}
    </Dialog>
  );
}

function SaveBody({ message, onClose }: { message: Msg; onClose: () => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    jsonFetch<{ projects: { id: string; name: string }[] }>("/api/projects")
      .then((r) => setProjects(r.projects))
      .catch((e: Error) => setError(e.message));
  }, []);

  const save = async (id: string, projectName: string) => {
    setBusy(id);
    setError(null);
    try {
      await saveNote(id, {
        title: message.content.replace(/[#*`>\n]+/g, " ").trim().slice(0, 80) || "Saved answer",
        content: message.content,
        sourceType: "chat",
        sourceRef: message.id,
      });
      setSaved(projectName);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {saved ? (
        <div className="flex flex-col items-center py-6 text-center">
          <span className="s-pop grid h-10 w-10 place-items-center rounded-full bg-s-accent-soft text-s-accent">
            <Check className="h-5 w-5" />
          </span>
          <p className="mt-3 text-[14px]">Saved to {saved}.</p>
          <button type="button" onClick={onClose} className={cn(btnQuiet, "mt-4")}>
            Done
          </button>
        </div>
      ) : (
        <>
          {error && <p role="alert" className="mb-3 text-[13px] text-s-danger">{error}</p>}
          {projects === null && !error ? (
            <div className="space-y-2">
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
                    disabled={!!busy}
                    onClick={() => void save(p.id, p.name)}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13.5px] transition hover:bg-s-hover disabled:opacity-50"
                  >
                    <FolderKanban className="h-4 w-4 text-s-ink-3" />
                    <span className="truncate">{p.name}</span>
                    {busy === p.id && <span className="ml-auto text-[12px] text-s-ink-3">Saving…</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            className="mt-4 flex gap-2 border-t border-s-line pt-4"
            onSubmit={async (e) => {
              e.preventDefault();
              const n = name.trim();
              if (!n) return;
              setBusy("new");
              try {
                const r = await jsonFetch<{ project: { id: string; name: string } }>("/api/projects", { method: "POST", body: JSON.stringify({ name: n }) });
                setName("");
                await save(r.project.id, r.project.name);
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
              Create & save
            </button>
          </form>
        </>
      )}
    </>
  );
}
