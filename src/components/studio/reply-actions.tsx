"use client";
import { useCallback, useState } from "react";
import { AddTaskDialog, SaveToProjectDialog } from "./dialogs";
import { useStudio } from "./frame";
import { followUpDraft, type Msg } from "./history";
import type { ReplyAction } from "./message";

/**
 * Turning replies into other things: a project note, task or milestone (signed
 * in, saved on the server), a saved prompt, or a new chat that quotes it.
 */
export function useReplyActions({ signedIn, onFollowUp }: { signedIn: boolean; onFollowUp: (draft: string) => void }) {
  const { addPrompt, notify } = useStudio();
  const [note, setNote] = useState<Msg | null>(null);
  const [task, setTask] = useState<{ m: Msg; kind: "task" | "milestone" } | null>(null);
  const act = useCallback(
    (action: ReplyAction, m: Msg) => {
      if (action === "note") setNote(m);
      else if (action === "task" || action === "milestone") setTask({ m, kind: action });
      else if (action === "prompt") notify(addPrompt(m.content) ? "Saved to your prompts" : "That's already in your prompts");
      else onFollowUp(followUpDraft(m.content));
    },
    [addPrompt, notify, onFollowUp],
  );
  const dialogs = (
    <>
      <SaveToProjectDialog message={note} onClose={() => setNote(null)} />
      <AddTaskDialog message={task?.m ?? null} kind={task?.kind ?? "task"} onClose={() => setTask(null)} />
    </>
  );
  return { act, projectActions: signedIn, dialogs };
}
