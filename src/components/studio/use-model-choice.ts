"use client";
import { useCallback } from "react";
import { useApp } from "@/components/layout/app-context";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useStudio } from "./frame";

/**
 * The user's chat model choice: "auto" (the lowest-cost available model) or a
 * model they picked. Signed-in users keep it on their account; guests on this
 * device. Nothing chosen yet means Auto.
 */
export function useModelChoice(): [string | null, (id: string) => void] {
  const { user, modelChoice, setModelChoice } = useApp();
  const { notify } = useStudio();
  const [local, setLocal] = useLocalStorage("nova:studio:model");
  const set = useCallback(
    (id: string) => {
      setLocal(id);
      if (user)
        void setModelChoice(id).then((saved) => {
          if (!saved) notify("Couldn’t save your model choice to your account. It applies on this device for now.");
        });
    },
    [setLocal, setModelChoice, user, notify],
  );
  return [user ? (modelChoice ?? local) : local, set];
}
