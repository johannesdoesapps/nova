"use client";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

export interface AppUser {
  id: string;
  email: string | null;
  displayName: string | null;
  /** Site administrator (can open Admin). Checked again on the server for every admin request. */
  isAdmin?: boolean;
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
  huggingface: boolean;
  search: boolean;
}

interface AppState {
  user: AppUser | null;
  integrations: IntegrationFlags;
  recents: Recents;
  refreshRecents: () => Promise<void>;
  supabasePublic: { url: string; key: string } | null;
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

  return <Ctx value={{ user, integrations, recents, refreshRecents, supabasePublic }}>{children}</Ctx>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside AppProvider");
  return v;
}
