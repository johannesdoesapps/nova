"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { OnboardingState } from "@/lib/onboarding";

export interface AppUser {
  id: string;
  email: string | null;
  displayName: string | null;
  /** Site administrator (can open Admin). Checked again on the server for every admin request. */
  isAdmin?: boolean;
  /** The chat model the user chose ("auto" or a model id), saved on their account. */
  preferredModel?: string | null;
  /** The starting point chosen (or skipped) in first-run onboarding, saved on the account. */
  onboarding?: OnboardingState | null;
  /** A new account: not onboarded and nothing made yet, so Home shows the guided start. */
  firstRun?: boolean;
}

export interface Recents {
  conversations: { id: string; title: string; updated_at: string }[];
  projects: { id: string; name: string; updated_at: string }[];
}

export interface IntegrationFlags {
  supabase: boolean;
  anthropic: boolean;
  openai: boolean;
  google: boolean;
  xai: boolean;
  deepseek: boolean;
  zai: boolean;
  huggingface: boolean;
  search: boolean;
  /** Stripe payments are set up (Pro can be bought). */
  billing: boolean;
  /** GitHub import is set up on this site (the GitHub App is configured). */
  github?: boolean;
}

interface AppState {
  user: AppUser | null;
  integrations: IntegrationFlags;
  recents: Recents;
  refreshRecents: () => Promise<void>;
  supabasePublic: { url: string; key: string } | null;
  /** The signed-in user's saved model choice (null when they haven't chosen). */
  modelChoice: string | null;
  /** Resolves false when the choice couldn't be saved to the account (it still applies on this device). */
  setModelChoice: (id: string) => Promise<boolean>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({
  user,
  integrations,
  initialRecents,
  supabasePublic,
  children,
}: {
  user: AppUser | null;
  integrations: IntegrationFlags;
  initialRecents: Recents;
  supabasePublic: { url: string; key: string } | null;
  children: ReactNode;
}) {
  const [recents, setRecents] = useState(initialRecents);
  // Re-seed when the server sends fresh data (e.g. after router.refresh()).
  const [seed, setSeed] = useState(initialRecents);
  if (seed !== initialRecents) {
    setSeed(initialRecents);
    setRecents(initialRecents);
  }

  const refreshRecents = useCallback(async () => {
    if (!user) return;
    try {
      const [c, p] = await Promise.all([fetch("/api/conversations"), fetch("/api/projects")]);
      const cj = c.ok ? ((await c.json()) as { conversations: Recents["conversations"] }) : { conversations: [] };
      const pj = p.ok ? ((await p.json()) as { projects: Recents["projects"] }) : { projects: [] };
      setRecents({ conversations: cj.conversations.slice(0, 8), projects: pj.projects.slice(0, 6) });
    } catch {
      /* non-critical */
    }
  }, [user]);

  // The model choice is saved on the account, so it follows the user to other devices.
  const [modelChoice, setChoice] = useState<string | null>(user?.preferredModel ?? null);
  const setModelChoice = useCallback(
    async (id: string) => {
      setChoice(id);
      if (!user) return true;
      try {
        const res = await fetch("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preferredModel: id }) });
        return res.ok;
      } catch {
        // Kept on this device; saved again on the next change.
        return false;
      }
    },
    [user],
  );

  return <Ctx value={{ user, integrations, recents, refreshRecents, supabasePublic, modelChoice, setModelChoice }}>{children}</Ctx>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}
