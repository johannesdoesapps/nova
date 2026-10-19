"use client";
import { useCallback } from "react";
import { useApp } from "@/components/layout/app-context";
import { useLocalStorage } from "@/hooks/use-local-storage";

/**
 * The user's chat model choice: "auto" (the lowest-cost available model) or a
 * model they picked. Signed-in users keep it on their account; guests on this
 * device. Nothing chosen yet means Auto.
 */
export function useModelChoice(): [string | null, (id: string) => void] {
  const { user, modelChoice, setModelChoice } = useApp();
  const [local, setLocal] = useLocalStorage("nova:studio:model");
  const set = useCallback(
    (id: string) => {
      setLocal(id);
      if (user) setModelChoice(id);
    },
    [setLocal, setModelChoice, user],
  );
  return [user ? (modelChoice ?? local) : local, set];
}
