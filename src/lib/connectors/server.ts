import "server-only";
import { isAdmin } from "@/lib/admin";
import { requireUser, type AuthContext } from "@/lib/auth";
import { publicEnv } from "@/lib/env";
import { githubAppConfig } from "@/lib/github/app";
import { ApiError } from "@/lib/http";
import { limiter } from "@/lib/rate-limit";
import type { CatalogEntry } from "./catalog";
import { connectorKeyConfigured } from "./crypto";
import { missingSetup, redirectUri } from "./oauth";
import { connector, REGISTRY } from "./registry";
import { listConnections, toView, type Authed } from "./runtime";
import type { Connector } from "./types";

/** The signed-in user, rate limited per user for connector requests. */
export async function connectorUser(bucket = "connectors", perMinute = 60): Promise<Authed> {
  const auth = await requireUser();
  if (!limiter(bucket, perMinute, 60_000).check(`u:${auth.user.id}`, 1).ok) throw new ApiError("rate_limited", "Too many requests. Please wait a moment.");
  return auth;
}

export function connectorOr404(id: string): Connector {
  const c = /^[a-z][a-z0-9_]{1,39}$/.test(id) ? connector(id) : null;
  if (!c) throw new ApiError("not_found", "There's no such connector.");
  return c;
}

/** Whether the connector can be connected on this site now. */
export function available(c: Connector): boolean {
  if (c.meta.auth === "github_app") return !!githubAppConfig();
  return missingSetup(c).length === 0;
}

/** Every connector with its availability and, for a signed-in user, their connection. Missing setup is shown to administrators only. */
export async function catalogFor(auth: AuthContext): Promise<{ connectors: CatalogEntry[]; admin: boolean; setup: { redirectUri: string; keyConfigured: boolean } | null }> {
  const signedIn = auth.mode === "authenticated";
  const [rows, admin] = signedIn ? await Promise.all([listConnections(auth), isAdmin(auth)]) : [[], false];
  const connectors = Object.values(REGISTRY).map((c) => {
    const row = rows.find((r) => r.connector_id === c.meta.id);
    const entry: CatalogEntry = { ...c.meta, available: available(c), connection: row ? toView(row) : null };
    if (admin) entry.missing = missingSetup(c);
    return entry;
  });
  return { connectors, admin, setup: admin ? { redirectUri: redirectUri(publicEnv.siteUrl), keyConfigured: connectorKeyConfigured() } : null };
}
