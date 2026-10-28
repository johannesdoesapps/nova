/**
 * Coding tasks that keep working after their page is closed (src/lib/code/agent/background.ts): only Orbis may call
 * the worker; it leaves a run to the page while the page is driving it; otherwise it acts as the run's owner (a
 * session opened on the server, signed out afterwards: never the admin client), takes steps, and hands over to a
 * fresh call while work is left. Errors stop it rather than looping. Supabase, the engine and fetch are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://db.test";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "pk_test";
  return {
    run: null as Record<string, unknown> | null,
    afterRun: null as Record<string, unknown> | null,
    reads: 0,
    calls: [] as string[],
    clients: [] as { key: string; headers: Record<string, string> }[],
    step: (async () => ({ run: {} })) as (...a: unknown[]) => Promise<unknown>,
    stepCalls: [] as unknown[][],
    events: [] as unknown[],
    kicks: [] as { url: string; auth: string | null; body: string }[],
    otpUser: "user-1",
  };
});

vi.mock("@/lib/supabase/admin", () => ({
  serviceSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            env.reads++;
            return { data: env.reads > 1 && env.afterRun ? env.afterRun : env.run };
          },
        }),
      }),
    }),
    auth: {
      admin: {
        getUserById: async (id: string) => {
          env.calls.push(`getUser:${id}`);
          return { data: { user: { id, email: "owner@example.com", user_metadata: { display_name: "Owner" } } }, error: null };
        },
        generateLink: async (p: { type: string; email: string }) => {
          env.calls.push(`link:${p.type}:${p.email}`);
          return { data: { properties: { hashed_token: "hash-123" } }, error: null };
        },
        signOut: async (jwt: string, scope: string) => {
          env.calls.push(`signOut:${jwt}:${scope}`);
          return { data: null, error: null };
        },
      },
    },
  }),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, key: string, opts: { global?: { headers?: Record<string, string> } }) => {
    env.clients.push({ key, headers: opts.global?.headers ?? {} });
    return {
      auth: {
        verifyOtp: async (p: { type: string; token_hash: string }) => {
          env.calls.push(`verify:${p.type}:${p.token_hash}`);
          return { data: { user: { id: env.otpUser }, session: { access_token: "owner-access-token" } }, error: null };
        },
      },
    };
  },
}));
vi.mock("@/lib/code/agent/engine", () => ({
  stepRun: (...a: unknown[]) => {
    env.stepCalls.push(a);
    return env.step(...a);
  },
}));
vi.mock("@/lib/code/agent/runs", () => ({ addEvents: async (_a: unknown, _id: string, evs: unknown[]) => env.events.push(...evs) }));

const RUN = "3f6c1b8e-2a4d-4c6e-9f1a-0b2c3d4e5f60";
const quiet = (over: Record<string, unknown> = {}) => ({
  id: RUN,
  user_id: "user-1",
  status: "running",
  options: { background: true },
  locked_until: null,
  updated_at: new Date(Date.now() - 60_000).toISOString(),
  steps: 4,
  pending: null,
  ...over,
});

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", "s3cret");
  Object.assign(env, { run: null, afterRun: null, reads: 0, otpUser: "user-1" });
  env.calls.length = env.clients.length = env.stepCalls.length = env.events.length = env.kicks.length = 0;
  env.step = async () => ({ run: { steps: 6, status: "running" } });
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit) => {
    env.kicks.push({ url: String(url), auth: new Headers(init.headers).get("authorization"), body: String(init.body) });
    return new Response("{}", { status: 202 });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("who may call the worker", () => {
  it("only a request with the worker secret", async () => {
    const { workerAuthorized } = await import("@/lib/code/agent/background");
    const req = (auth?: string) => new Request("https://x.test/api/code/agent/worker", { method: "POST", headers: auth ? { authorization: auth } : {} });
    expect(workerAuthorized(req("Bearer s3cret"))).toBe(true);
    expect(workerAuthorized(req("Bearer s3cre"))).toBe(false);
    expect(workerAuthorized(req())).toBe(false);
    vi.stubEnv("CRON_SECRET", "");
    expect(workerAuthorized(req("Bearer "))).toBe(false);
  });

  it("the route refuses others and accepts Orbis at once", async () => {
    const drive = vi.fn(async () => "page" as const);
    vi.doMock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void fn() }));
    vi.doMock("@/lib/code/agent/background", async (orig) => ({ ...(await orig<typeof import("@/lib/code/agent/background")>()), driveInBackground: drive }));
    const { POST } = await import("@/app/api/code/agent/worker/route");
    const call = (auth: string | null, body: unknown) =>
      POST(new Request("https://tryorbis.app/api/code/agent/worker", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) } }));
    expect((await call(null, { runId: RUN })).status).toBe(401);
    expect((await call("Bearer nope", { runId: RUN })).status).toBe(401);
    expect((await call("Bearer s3cret", { runId: "not-a-uuid" })).status).toBe(400);
    expect(drive).not.toHaveBeenCalled();
    const ok = await call("Bearer s3cret", { runId: RUN });
    expect(ok.status).toBe(202);
    expect(drive).toHaveBeenCalledWith(RUN, "https://tryorbis.app");
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/code/agent/background");
  });
});

describe("when the worker steps in", () => {
  it("only for working runs started with keep-working, that nobody has touched for a few seconds", async () => {
    const { needsWorker, QUIET_MS } = await import("@/lib/code/agent/background");
    const now = Date.now();
    expect(needsWorker(quiet() as never, now)).toBe(true);
    expect(needsWorker(null, now)).toBe(false);
    expect(needsWorker(quiet({ options: {} }) as never, now)).toBe(false);
    expect(needsWorker(quiet({ options: null }) as never, now)).toBe(false);
    expect(needsWorker(quiet({ status: "needs_input" }) as never, now)).toBe(false);
    expect(needsWorker(quiet({ status: "completed" }) as never, now)).toBe(false);
    expect(needsWorker(quiet({ pending: { kind: "question" } }) as never, now)).toBe(false);
    expect(needsWorker(quiet({ locked_until: new Date(now + 60_000).toISOString() }) as never, now)).toBe(false);
    expect(needsWorker(quiet({ locked_until: new Date(now - 1_000).toISOString() }) as never, now)).toBe(true);
    expect(needsWorker(quiet({ updated_at: new Date(now - 1_000).toISOString() }) as never, now)).toBe(false);
    expect(needsWorker(quiet({ updated_at: new Date(now - QUIET_MS).toISOString() }) as never, now)).toBe(true);
  });
});

describe("taking steps in the background", () => {
  it("leaves the run to the page while the page is driving it", async () => {
    const { driveInBackground } = await import("@/lib/code/agent/background");
    env.run = quiet({ updated_at: new Date().toISOString() });
    expect(await driveInBackground(RUN, "https://tryorbis.app", { wait: 0 })).toBe("page");
    expect(env.stepCalls).toHaveLength(0);
    expect(env.calls).toEqual([]);
  });

  it("acts as the owner, not as an administrator, signs that session out, and hands over while work is left", async () => {
    const { driveInBackground, WORKER_STEP_MS } = await import("@/lib/code/agent/background");
    env.run = quiet();
    env.afterRun = quiet({ steps: 6 });
    expect(await driveInBackground(RUN, "https://tryorbis.app", { wait: 0 })).toBe("handed_over");
    expect(env.calls).toEqual(["getUser:user-1", "link:magiclink:owner@example.com", "verify:email:hash-123", "signOut:owner-access-token:local"]);
    // The engine got a client that carries the owner's own access token on the publishable key.
    const [, auth, runId, opts] = env.stepCalls[0] as [Request, { user: { id: string; displayName: string }; supabase: unknown }, string, Record<string, unknown>];
    expect(runId).toBe(RUN);
    expect(auth.user).toMatchObject({ id: "user-1", displayName: "Owner" });
    expect(env.clients.at(-1)).toEqual({ key: "pk_test", headers: { Authorization: "Bearer owner-access-token" } });
    expect(opts).toEqual({ expectStep: 4, keepGoingMs: WORKER_STEP_MS });
    expect(env.kicks).toEqual([{ url: "https://tryorbis.app/api/code/agent/worker", auth: "Bearer s3cret", body: JSON.stringify({ runId: RUN }) }]);
  });

  it("stops handing over when the run ends, waits for the user, or made no progress", async () => {
    const { driveInBackground } = await import("@/lib/code/agent/background");
    for (const [afterRun, step] of [
      [quiet({ steps: 6, status: "completed" }), { run: { steps: 6 } }],
      [quiet({ steps: 6, pending: { kind: "question" } }), { run: { steps: 6 } }],
      [quiet(), { run: { steps: 4 }, skipped: "busy" }],
    ] as const) {
      Object.assign(env, { run: quiet(), afterRun, reads: 0 });
      env.step = async () => step;
      expect(await driveInBackground(RUN, "https://tryorbis.app", { wait: 0 })).toBe("done");
    }
    expect(env.kicks).toHaveLength(0);
    expect(env.calls.filter((c) => c.startsWith("signOut"))).toHaveLength(3);
  });

  it("on an error: logs it on the run, signs out, and doesn't retry in a loop", async () => {
    const { driveInBackground } = await import("@/lib/code/agent/background");
    env.run = quiet();
    env.step = async () => {
      throw new Error("You've used this week's allowance.");
    };
    expect(await driveInBackground(RUN, "https://tryorbis.app", { wait: 0 })).toBe("error");
    expect(env.events).toEqual([{ kind: "status", title: "Stopped working in the background: You've used this week's allowance." }]);
    expect(env.calls.at(-1)).toBe("signOut:owner-access-token:local");
    expect(env.kicks).toHaveLength(0);
  });

  it("counts verification moving on as progress, though it takes no steps", async () => {
    const { driveInBackground } = await import("@/lib/code/agent/background");
    env.run = quiet({ checks: { verify: { queue: ["build", "test"], attempts: 0 } } });
    env.afterRun = quiet({ checks: { verify: { queue: ["test"], attempts: 0 } } });
    env.step = async () => ({ run: { steps: 4, status: "running" } });
    expect(await driveInBackground(RUN, "https://tryorbis.app", { wait: 0 })).toBe("handed_over");
    expect(env.kicks).toHaveLength(1);
  });

  it("tries again from a fresh worker when the model failed (the engine counts those and gives up after a few)", async () => {
    const { driveInBackground } = await import("@/lib/code/agent/background");
    env.run = quiet({ usage: { modelFailuresInRow: 0 } });
    env.afterRun = quiet({ usage: { modelFailuresInRow: 1 } });
    env.step = async () => {
      throw new Error("The model provider is busy.");
    };
    expect(await driveInBackground(RUN, "https://tryorbis.app", { wait: 0 })).toBe("handed_over");
    expect(env.kicks).toHaveLength(1);
    expect(env.events).toEqual([]);
    expect(env.calls.at(-1)).toBe("signOut:owner-access-token:local");
    // Once the engine has failed the run, nothing is retried.
    Object.assign(env, { run: quiet({ usage: { modelFailuresInRow: 2 } }), afterRun: quiet({ status: "failed", usage: { modelFailuresInRow: 3 } }), reads: 0 });
    env.kicks.length = 0;
    expect(await driveInBackground(RUN, "https://tryorbis.app", { wait: 0 })).toBe("error");
    expect(env.kicks).toHaveLength(0);
  });

  it("does nothing if the session doesn't belong to the run's owner", async () => {
    const { driveInBackground } = await import("@/lib/code/agent/background");
    env.run = quiet();
    env.otpUser = "someone-else";
    expect(await driveInBackground(RUN, "https://tryorbis.app", { wait: 0 })).toBe("unavailable");
    expect(env.stepCalls).toHaveLength(0);
  });

  it("can't be asked for without the worker secret set", async () => {
    const { kickWorker } = await import("@/lib/code/agent/background");
    vi.stubEnv("CRON_SECRET", "");
    await kickWorker(RUN, "https://tryorbis.app");
    expect(env.kicks).toHaveLength(0);
  });
});
