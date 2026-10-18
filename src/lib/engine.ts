import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { getAuth } from "./auth";
import { ApiError } from "./http";

/**
 * Bridge to the Python NOVA engine (AI Lab, Radar, Workspaces, Integrations).
 * The browser never talks to the engine: every call goes through Next.js,
 * which authenticates the user and signs a short-lived identity with
 * NOVA_ENGINE_SECRET. Guests get a random, httpOnly guest id cookie so their
 * demo data stays separate from everyone else's.
 */

export const GUEST_COOKIE = "nova_guest";

export function engineConfig() {
  return {
    url: (process.env.NOVA_ENGINE_URL?.trim() || "http://127.0.0.1:8787").replace(/\/$/, ""),
    secret: process.env.NOVA_ENGINE_SECRET?.trim() || null,
  };
}

export function signIdentity(sub: string, secret: string, email: string | null, name: string | null, ttlS = 120): string {
  const payload = JSON.stringify({ sub, email, name, exp: Math.floor(Date.now() / 1000) + ttlS });
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
  return `${Buffer.from(payload).toString("base64url")}.${mac}`;
}

export async function engineIdentity(): Promise<{ sub: string; email: string | null; name: string | null; guest: boolean }> {
  const auth = await getAuth();
  if (auth.mode === "authenticated") return { sub: auth.user.id, email: auth.user.email, name: auth.user.displayName, guest: false };
  const jar = await cookies();
  let id = jar.get(GUEST_COOKIE)?.value;
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    id = randomUUID();
    jar.set(GUEST_COOKIE, id, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 180 });
  }
  return { sub: `guest:${id}`, email: null, name: null, guest: true };
}

export async function engineFetch(path: string, init: { method?: string; body?: string; query?: string; requestId?: string } = {}): Promise<Response> {
  const { url, secret } = engineConfig();
  if (!secret) throw new ApiError("not_configured", "The NOVA engine is not configured. Set NOVA_ENGINE_SECRET (and NOVA_ENGINE_URL) for both the web app and the engine.");
  const who = await engineIdentity();
  try {
    return await fetch(`${url}/${path}${init.query ? `?${init.query}` : ""}`, {
      method: init.method ?? "GET",
      body: init.body,
      headers: {
        "Content-Type": "application/json",
        "X-Nova-Identity": signIdentity(who.sub, secret, who.email, who.name),
        ...(init.requestId ? { "X-Request-Id": init.requestId } : {}),
      },
      signal: AbortSignal.timeout(120_000),
      cache: "no-store",
    });
  } catch {
    throw new ApiError("not_configured", `The NOVA engine is not reachable at ${url}. Start it with: cd engine && .venv/bin/python -m nova_engine`);
  }
}
