"use client";
import { useCallback, useState } from "react";
import { AddTaskDialog, SaveToProjectDialog } from "./dialogs";
import { useStudio } from "./frame";
import { reportEvent } from "./feedback";
import { followUpDraft, type Msg } from "./history";
import type { ReplyAction } from "./message";

/**
 * Turning replies into other things: a project note, task or milestone (signed
 * in, saved on the server), a saved prompt, or a new chat that quotes it.
 */
export function useReplyActions({ signedIn, onFollowUp, feature = "chat" }: { signedIn: boolean; onFollowUp: (draft: string) => void; feature?: "chat" | "agent" }) {
  const { addPrompt, notify } = useStudio();
  const [note, setNote] = useState<Msg | null>(null);
  const [task, setTask] = useState<{ m: Msg; kind: "task" | "milestone" } | null>(null);
  const act = useCallback(
    (action: ReplyAction, m: Msg) => {
      // Doing something with a reply counts as a useful result (for the product metrics; no text is sent).
      if (signedIn) reportEvent("useful_result", { how: action === "note" ? "note" : action, feature });
      if (action === "note") setNote(m);
      else if (action === "task" || action === "milestone") setTask({ m, kind: action });
      else if (action === "prompt") notify(addPrompt(m.content) ? "Saved to your prompts" : "That's already in your prompts");
      else onFollowUp(followUpDraft(m.content));
    },
    [addPrompt, notify, onFollowUp, signedIn, feature],
  );
  const dialogs = (
    <>
      <SaveToProjectDialog message={note} onClose={() => setNote(null)} />
      <AddTaskDialog message={task?.m ?? null} kind={task?.kind ?? "task"} onClose={() => setTask(null)} />
    </>
  );
  return { act, projectActions: signedIn, dialogs };
}
