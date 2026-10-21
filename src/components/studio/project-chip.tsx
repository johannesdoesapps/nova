"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Check, FolderKanban, NotebookPen, ScrollText } from "lucide-react";
import { jsonFetch } from "@/hooks/use-ndjson";
import type { ContextSettings } from "@/lib/projects/context";
import type { ProjectUse } from "./chat-client";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ui";

export interface ProjectContextView {
  name: string;
  settings: ContextSettings;
  instructions: string;
  used: { instructions: boolean; notes: number };
}

/** One project's shared-context settings, loaded from and saved to the server. */
export function useProjectContext(projectId: string | null) {
  const [data, setData] = useState<{ id: string; view: ProjectContextView } | { id: string; error: string } | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    jsonFetch<ProjectContextView>(`/api/projects/${projectId}/context`)
      .then((view) => alive && setData({ id: projectId, view }))
      .catch((e: Error) => alive && setData({ id: projectId, error: e.message }));
    return () => {
      alive = false;
    };
  }, [projectId, version]);
  const current = data && data.id === projectId ? data : null;
  const update = useCallback(
    async (patch: Partial<ContextSettings>) => {
      if (!projectId) return;
      await jsonFetch(`/api/projects/${projectId}/context`, { method: "PATCH", body: JSON.stringify(patch) });
      setVersion((v) => v + 1);
    },
    [projectId],
  );
  return { view: current && "view" in current ? current.view : null, error: current && "error" in current ? current.error : null, update, reload: () => setVersion((v) => v + 1) };
}

/**
 * The chat's project, in the top bar: what of the project's saved information
 * replies can see, with switches to change it. Other projects are never shared.
 */
export function ProjectChip({ projectId, use, notify }: { projectId: string; use: ProjectUse | null; notify: (t: string) => void }) {
  const { view, error, update } = useProjectContext(projectId);
  const name = view?.name ?? use?.name ?? "Project";
  const hasInstructions = !!view?.instructions.trim();
  const toggle = async (patch: Partial<ContextSettings>, done: string) => {
    try {
      await update(patch);
      notify(done);
    } catch (e) {
      notify(`Couldn’t change it: ${(e as Error).message}`);
    }
  };
  return (
    <Menu
      label={`Project ${name}`}
      align="end"
      width={290}
      buttonTitle={`In project ${name}: see what replies can use`}
      buttonClassName="inline-flex h-8 max-w-[200px] items-center gap-1.5 rounded-full border border-s-line px-2.5 text-[12.5px] text-s-ink-2 transition hover:bg-s-hover hover:text-s-ink"
      button={
        <>
          <FolderKanban className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{name}</span>
        </>
      }
    >
      <MenuLabel>Replies in this chat can use</MenuLabel>
      {error ? (
        <p className="px-2.5 py-2 text-[12.5px] text-s-danger">{error}</p>
      ) : !view ? (
        <p className="px-2.5 py-2 text-[12.5px] text-s-ink-3">Loading…</p>
      ) : (
        <>
          <MenuItem
            role="menuitemcheckbox"
            checked={view.settings.instructions}
            icon={<ScrollText />}
            right={view.settings.instructions ? <Check /> : null}
            hint={hasInstructions ? (view.settings.instructions ? "Shared with this project’s chats" : "Not shared") : "None written yet"}
            onClick={() => void toggle({ instructions: !view.settings.instructions }, view.settings.instructions ? "Project instructions won’t be used" : "Project instructions will be used")}
          >
            Project instructions
          </MenuItem>
          <MenuItem
            role="menuitemcheckbox"
            checked={view.settings.notes}
            icon={<NotebookPen />}
            right={view.settings.notes ? <Check /> : null}
            hint={view.settings.notes ? `Up to the 10 newest notes${view.used.notes ? ` (${view.used.notes} now)` : ""}` : "Not shared"}
            onClick={() => void toggle({ notes: !view.settings.notes }, view.settings.notes ? "Project notes won’t be used" : "Project notes will be used")}
          >
            Project notes
          </MenuItem>
          <p className="px-2.5 pb-1 pt-1.5 text-[11.5px] leading-snug text-s-ink-3">Changes apply from your next message. Nothing from your other projects is shared.</p>
        </>
      )}
      <MenuSeparator />
      <Link href={`/missions/${projectId}#instructions`} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-[13.5px] text-s-ink transition-colors hover:bg-s-hover">
        <FolderKanban className="h-4 w-4 text-s-ink-2" />
        Open project
      </Link>
    </Menu>
  );
}
