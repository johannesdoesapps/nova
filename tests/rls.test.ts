/**
 * Applies the real migration to an in-process Postgres (PGlite) with a minimal
 * Supabase-like auth shim, then checks Row Level Security as two different users.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
let db: PGlite;

async function as<T>(user: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${user ?? ""}', false);`);
  await db.exec(user ? "set role authenticated" : "set role anon");
  try {
    return await fn();
  } finally {
    await db.exec("reset role");
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  const dir = join(__dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  await db.exec(`
    grant usage on schema public to anon, authenticated;
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant select on all tables in schema public to anon;
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ALICE}', 'alice@example.com', '{"display_name":"Alice"}'),
      ('${BOB}', 'bob@example.com', '{}');
    insert into public.model_registry (id, provider, provider_model_id, display_name) values ('openai:x', 'openai', 'x', 'X');
  `);
}, 60_000);

describe("schema", () => {
  it("creates a profile automatically on sign-up", async () => {
    const r = await db.query<{ id: string; display_name: string }>("select id, display_name from public.profiles order by display_name");
    expect(r.rows.map((x) => x.display_name)).toEqual(["Alice", "bob"]);
  });

  it("names profiles from Google sign-ups (full_name / name), falling back to the email", async () => {
    const G1 = "33333333-3333-4333-8333-333333333333", G2 = "44444444-4444-4444-8444-444444444444", G3 = "55555555-5555-4555-8555-555555555555";
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${G1}', 'g1@gmail.com', '{"full_name":"Grace Hopper","name":"Grace H","avatar_url":"https://x/y.png"}'),
        ('${G2}', 'g2@gmail.com', '{"display_name":"  ","name":"Ada"}'),
        ('${G3}', 'g3@gmail.com', '{"iss":"https://accounts.google.com"}');
    `);
    const r = await db.query<{ id: string; display_name: string }>("select id, display_name from public.profiles where id in ($1, $2, $3)", [G1, G2, G3]);
    const by = Object.fromEntries(r.rows.map((x) => [x.id, x.display_name]));
    expect(by).toEqual({ [G1]: "Grace Hopper", [G2]: "Ada", [G3]: "g3" });
    await db.exec(`delete from auth.users where id in ('${G1}', '${G2}', '${G3}')`);
  });
});

describe("row level security", () => {
  let aliceProject: string;
  let aliceConversation: string;

  it("lets a user create and read their own rows", async () => {
    await as(ALICE, async () => {
      const p = await db.query<{ id: string }>("insert into public.projects (name) values ('Startup Research') returning id");
      aliceProject = p.rows[0]!.id;
      const c = await db.query<{ id: string }>("insert into public.conversations (title, project_id) values ('Hi', $1) returning id", [aliceProject]);
      aliceConversation = c.rows[0]!.id;
      await db.query("insert into public.messages (conversation_id, role, content) values ($1, 'user', 'secret plan')", [aliceConversation]);
      await db.query("insert into public.project_notes (project_id, title, content) values ($1, 'n', 'c')", [aliceProject]);
      const mine = await db.query("select * from public.projects");
      expect(mine.rows).toHaveLength(1);
      const user = await db.query<{ user_id: string }>("select user_id from public.projects");
      expect(user.rows[0]!.user_id).toBe(ALICE);
    });
  });

  it("hides another user's projects, conversations, messages and notes", async () => {
    await as(BOB, async () => {
      for (const t of ["projects", "conversations", "messages", "project_notes", "profiles"]) {
        const r = await db.query<{ id: string }>(`select * from public.${t}`);
        if (t === "profiles") expect(r.rows.map((x) => x.id)).toEqual([BOB]);
        else expect(r.rows).toHaveLength(0);
      }
    });
  });

  it("prevents updating or deleting another user's data", async () => {
    await as(BOB, async () => {
      const u = await db.query("update public.projects set name = 'pwned' where id = $1", [aliceProject]);
      expect(u.affectedRows).toBe(0);
      const d = await db.query("delete from public.conversations where id = $1", [aliceConversation]);
      expect(d.affectedRows).toBe(0);
    });
    const check = await db.query<{ name: string }>("select name from public.projects where id = $1", [aliceProject]);
    expect(check.rows[0]!.name).toBe("Startup Research");
  });

  it("prevents writing rows on behalf of someone else", async () => {
    await as(BOB, async () => {
      await expect(db.query("insert into public.projects (user_id, name) values ($1, 'fake')", [ALICE])).rejects.toThrow(/row-level security/);
      await expect(
        db.query("insert into public.messages (conversation_id, role, content) values ($1, 'user', 'injected')", [aliceConversation]),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("prevents attaching your rows to another user's project", async () => {
    await as(BOB, async () => {
      await expect(db.query("insert into public.conversations (title, project_id) values ('sneaky', $1)", [aliceProject])).rejects.toThrow(
        /row-level security/,
      );
      await expect(db.query("insert into public.project_notes (project_id, title, content) values ($1, 't', 'c')", [aliceProject])).rejects.toThrow(
        /row-level security/,
      );
    });
  });

  it("lets anonymous visitors read the model registry but nothing private", async () => {
    await as(null, async () => {
      const reg = await db.query("select * from public.model_registry");
      expect(reg.rows).toHaveLength(1);
      const projects = await db.query("select * from public.projects");
      expect(projects.rows).toHaveLength(0);
    });
  });

  it("does not let users edit the model registry or other users' usage records", async () => {
    await as(ALICE, async () => {
      const u = await db.query("update public.model_registry set input_price = 0 where id = 'openai:x'");
      expect(u.affectedRows).toBe(0);
      await db.query("insert into public.model_runs (model_id, status) values ('openai:x', 'success')");
      const upd = await db.query("update public.model_runs set estimated_cost = 0");
      expect(upd.affectedRows).toBe(0);
    });
    await as(BOB, async () => {
      expect((await db.query("select * from public.model_runs")).rows).toHaveLength(0);
    });
  });
});

describe("agents", () => {
  let aliceAgent: string;
  let aliceAgentChat: string;
  const instructions = "You are a careful research helper for my thesis.";

  it("lets a user create a private agent and attach conversations to it", async () => {
    await as(ALICE, async () => {
      const a = await db.query<{ id: string }>(
        "insert into public.agents (name, instructions, capabilities) values ('Thesis Helper', $1, array['file_analysis']) returning id",
        [instructions],
      );
      aliceAgent = a.rows[0]!.id;
      const c = await db.query<{ id: string }>("insert into public.conversations (title, agent_id) values ('Chapter 2', $1) returning id", [aliceAgent]);
      aliceAgentChat = c.rows[0]!.id;
      await db.query("insert into public.conversations (title, builtin_agent) values ('Ask research', 'research')");
      const mine = await db.query("select * from public.agents");
      expect(mine.rows).toHaveLength(1);
    });
  });

  it("hides one user's agents and agent conversations from another", async () => {
    await as(BOB, async () => {
      expect((await db.query("select * from public.agents")).rows).toHaveLength(0);
      expect((await db.query("select * from public.conversations where agent_id is not null or builtin_agent is not null")).rows).toHaveLength(0);
      const u = await db.query("update public.agents set instructions = 'pwned instructions for the agent' where id = $1", [aliceAgent]);
      expect(u.affectedRows).toBe(0);
    });
  });

  it("prevents attaching a conversation to someone else's agent", async () => {
    await as(BOB, async () => {
      await expect(db.query("insert into public.conversations (title, agent_id) values ('sneaky', $1)", [aliceAgent])).rejects.toThrow(
        /row-level security/,
      );
    });
  });

  it("rejects unknown capabilities, unknown built-ins and a conversation with two agents", async () => {
    await as(ALICE, async () => {
      await expect(
        db.query("insert into public.agents (name, instructions, capabilities) values ('x', $1, array['shell_access'])", [instructions]),
      ).rejects.toThrow(/check constraint/);
      await expect(db.query("insert into public.conversations (title, builtin_agent) values ('x', 'hacker')")).rejects.toThrow(/check constraint/);
      await expect(
        db.query("insert into public.conversations (title, agent_id, builtin_agent) values ('x', $1, 'research')", [aliceAgent]),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it("deletes an agent's conversations with the agent", async () => {
    await as(ALICE, async () => {
      await db.query("delete from public.agents where id = $1", [aliceAgent]);
      expect((await db.query("select * from public.conversations where id = $1", [aliceAgentChat])).rows).toHaveLength(0);
      expect((await db.query("select * from public.conversations where builtin_agent = 'research'")).rows).toHaveLength(1);
    });
  });
});

describe("subscriptions", () => {
  it("lets users read their own plan but never grant themselves Pro", async () => {
    await db.exec(`insert into public.subscriptions (user_id, plan, status) values ('${ALICE}', 'pro', 'active')`);
    await as(ALICE, async () => {
      const r = await db.query<{ plan: string }>("select plan from public.subscriptions");
      expect(r.rows).toEqual([{ plan: "pro" }]);
    });
    await as(BOB, async () => {
      expect((await db.query("select * from public.subscriptions")).rows).toHaveLength(0);
      await expect(db.query(`insert into public.subscriptions (user_id, plan, status) values ('${BOB}', 'pro', 'active')`)).rejects.toThrow(/row-level security/);
      const u = await db.query(`update public.subscriptions set user_id = '${BOB}' where user_id = '${ALICE}'`);
      expect(u.affectedRows).toBe(0);
    });
    await as(ALICE, async () => {
      const u = await db.query("update public.subscriptions set status = 'active', plan = 'pro'");
      expect(u.affectedRows).toBe(0);
    });
  });
});

describe("platform settings", () => {
  it("lets everyone read settings but only administrators change them", async () => {
    await db.exec("set role anon");
    try {
      const r = await db.query<{ id: number }>("select id from public.app_settings");
      expect(r.rows).toEqual([{ id: 1 }]);
    } finally {
      await db.exec("reset role");
    }
    await as(BOB, async () => {
      const u = await db.query(`update public.app_settings set settings = '{"autoEnabled": false}' where id = 1`);
      expect(u.affectedRows).toBe(0);
      await expect(db.query(`insert into public.admins (user_id) values ('${BOB}')`)).rejects.toThrow(/row-level security|permission denied/);
    });
    await db.exec(`insert into public.admins (user_id) values ('${ALICE}')`);
    await as(ALICE, async () => {
      const u = await db.query(`update public.app_settings set settings = '{"autoEnabled": false}' where id = 1`);
      expect(u.affectedRows).toBe(1);
    });
    await as(BOB, async () => {
      expect((await db.query("select * from public.admins")).rows).toHaveLength(0);
    });
  });

  it("stores custom agents' response style and memory with valid values only", async () => {
    await as(ALICE, async () => {
      const r = await db.query<{ response_style: string; history_limit: number }>(
        "insert into public.agents (name, instructions) values ('Tutor', 'You help students understand algebra step by step.') returning response_style, history_limit",
      );
      expect(r.rows[0]).toEqual({ response_style: "balanced", history_limit: 20 });
      await expect(db.query("insert into public.agents (name, instructions, history_limit) values ('X', 'You help students understand algebra step by step.', 15)")).rejects.toThrow(/check/);
    });
  });
});

describe("council sessions and missions", () => {
  it("keeps Council and Arena sessions private to their owner", async () => {
    await as(ALICE, async () => {
      await db.query(`insert into public.council_sessions (kind, question, mode, models, result) values ('council', 'Q?', 'quick', array['a','b'], '{}')`);
      await expect(db.query(`insert into public.council_sessions (kind, question, mode, models, result) values ('arena', 'Q?', 'blind', array[]::text[], '{}')`)).rejects.toThrow(/check/);
    });
    await as(BOB, async () => {
      expect((await db.query("select * from public.council_sessions")).rows).toHaveLength(0);
      expect((await db.query("update public.council_sessions set question = 'x'")).affectedRows).toBe(0);
      await expect(db.query(`insert into public.council_sessions (user_id, kind, question, mode, models, result) values ('${ALICE}', 'council', 'Q', 'quick', array['a'], '{}')`)).rejects.toThrow(/row-level security/);
    });
  });

  it("keeps mission tasks and runs private and tied to the owner's own mission", async () => {
    const { project, task } = await as(ALICE, async () => {
      const p = await db.query<{ id: string; status: string }>("insert into public.projects (name, goal) values ('Mission', 'Ship it') returning id, status");
      expect(p.rows[0].status).toBe("active");
      const t = await db.query<{ id: string }>(`insert into public.project_tasks (project_id, title) values ('${p.rows[0].id}', 'Task 1') returning id`);
      await db.query(`insert into public.task_runs (task_id, project_id, model_id) values ('${t.rows[0].id}', '${p.rows[0].id}', 'openai:x')`);
      return { project: p.rows[0].id, task: t.rows[0].id };
    });
    await as(BOB, async () => {
      expect((await db.query("select * from public.project_tasks")).rows).toHaveLength(0);
      expect((await db.query("select * from public.task_runs")).rows).toHaveLength(0);
      await expect(db.query(`insert into public.project_tasks (project_id, title) values ('${project}', 'Sneaky')`)).rejects.toThrow(/row-level security/);
      await expect(db.query(`insert into public.task_runs (task_id, project_id, model_id) values ('${task}', '${project}', 'openai:x')`)).rejects.toThrow(/row-level security/);
      expect((await db.query(`update public.project_tasks set status = 'completed' where id = '${task}'`)).affectedRows).toBe(0);
    });
    await as(ALICE, async () => {
      await expect(db.query(`update public.project_tasks set status = 'done' where id = '${task}'`)).rejects.toThrow(/check/);
      await db.query(`delete from public.projects where id = '${project}'`);
      expect((await db.query("select * from public.task_runs")).rows).toHaveLength(0);
    });
  });
});

describe("security center", () => {
  it("keeps targets, runs and findings private, and the audit trail append-only", async () => {
    const { run } = await as(ALICE, async () => {
      await db.query(`insert into public.security_targets (hostname, token) values ('alice.example', 'orbis-verify-0123456789abcdef')`);
      await expect(db.query(`insert into public.security_targets (hostname, token) values ('BAD HOST!', 'orbis-verify-0123456789abcdef')`)).rejects.toThrow(/check/);
      const r = await db.query<{ id: string }>(`insert into public.security_runs (agent, action, asset) values ('sentinel', 'scan', 'alice.example') returning id`);
      await db.query(
        `insert into public.security_findings (run_id, agent, fingerprint, rule_id, title, severity, confidence, asset, evidence_source) values ('${r.rows[0].id}', 'sentinel', 'fp-0000000001', 'headers.hsts-missing', 'HSTS missing', 'medium', 'confirmed', 'alice.example', 'orbis:headers')`,
      );
      await expect(
        db.query(`insert into public.security_findings (agent, fingerprint, rule_id, title, severity, confidence, asset, evidence_source) values ('sentinel', 'fp-0000000001', 'x', 'dup', 'low', 'firm', 'a', 'x')`),
      ).rejects.toThrow(/duplicate key/);
      await expect(
        db.query(`insert into public.security_findings (agent, fingerprint, rule_id, title, severity, confidence, asset, evidence_source) values ('sentinel', 'fp-0000000002', 'x', 't', 'severe', 'firm', 'a', 'x')`),
      ).rejects.toThrow(/check/);
      await db.query(`insert into public.security_audit (action, run_id, detail) values ('scan.started', '${r.rows[0].id}', '{}')`);
      expect((await db.query("update public.security_audit set action = 'tampered'")).affectedRows).toBe(0);
      expect((await db.query("delete from public.security_audit")).affectedRows).toBe(0);
      expect((await db.query("select * from public.security_audit")).rows).toHaveLength(1);
      return { run: r.rows[0].id };
    });
    await as(BOB, async () => {
      for (const t of ["security_targets", "security_runs", "security_findings", "security_audit"]) expect((await db.query(`select * from public.${t}`)).rows, t).toHaveLength(0);
      expect((await db.query("update public.security_findings set status = 'verified'")).affectedRows).toBe(0);
      await expect(db.query(`insert into public.security_audit (user_id, action) values ('${ALICE}', 'forged')`)).rejects.toThrow(/row-level security/);
      await expect(db.query(`insert into public.security_runs (user_id, agent, action) values ('${ALICE}', 'sentinel', 'scan')`)).rejects.toThrow(/row-level security/);
      // Bob can't attach his own finding to Alice's run's id... he can't even see it, and fingerprints are per user.
      await db.query(`insert into public.security_findings (agent, fingerprint, rule_id, title, severity, confidence, asset, evidence_source) values ('sentinel', 'fp-0000000001', 'x', 'bob', 'low', 'firm', 'a', 'x')`);
    });
    await as(ALICE, async () => {
      expect((await db.query("select * from public.security_findings")).rows).toHaveLength(1);
      await db.query(`delete from public.security_runs where id = '${run}'`);
      const f = await db.query<{ run_id: string | null }>("select run_id from public.security_findings");
      expect(f.rows[0].run_id).toBeNull(); // findings outlive the run that found them
    });
  });
});

describe("workforce (operators only)", () => {
  it("lets only administrators read or write Workforce data, each seeing only their own", async () => {
    // ALICE was made an admin in the platform settings test above; BOB is a regular user.
    const ids = await as(ALICE, async () => {
      const p = await db.query<{ id: string }>(`insert into public.wf_projects (name, repo) values ('Orbis', 'acme/orbis') returning id`);
      await expect(db.query(`insert into public.wf_projects (name, repo) values ('Bad', 'not a repo!')`)).rejects.toThrow(/check/);
      const t = await db.query<{ id: string }>(`insert into public.wf_tasks (project_id, title, objective) values ('${p.rows[0].id}', 'Task', 'Do the thing') returning id`);
      await db.query(`insert into public.wf_steps (task_id, key, agent, agent_version, title) values ('${t.rows[0].id}', 'prepare', 'devops', '1.0.0', 'Prepare')`);
      await expect(db.query(`insert into public.wf_steps (task_id, key, agent, agent_version, title) values ('${t.rows[0].id}', 'prepare', 'devops', '1.0.0', 'dup')`)).rejects.toThrow(/duplicate key/);
      await db.query(`insert into public.wf_approvals (task_id, kind, title, payload_hash) values ('${t.rows[0].id}', 'plan', 'Approve', 'h')`);
      await db.query(`insert into public.wf_events (task_id, level, type, message) values ('${t.rows[0].id}', 'audit', 'task.created', 'x'), ('${t.rows[0].id}', 'info', 'note', 'y')`);
      await db.query(`insert into public.wf_memory (project_id, kind, content, source) values ('${p.rows[0].id}', 'project_knowledge', 'fact', 'task')`);
      // Audit events can't be edited or deleted; ordinary log lines can be deleted by retention.
      expect((await db.query("update public.wf_events set message = 'tampered'")).affectedRows).toBe(0);
      expect((await db.query("delete from public.wf_events where level = 'audit'")).affectedRows).toBe(0);
      expect((await db.query("delete from public.wf_events where level = 'info'")).affectedRows).toBe(1);
      expect((await db.query<{ id: number }>("select id from public.wf_settings")).rows).toHaveLength(1);
      expect((await db.query(`update public.wf_settings set settings = '{"maxAutonomy":"assist"}' where id = 1`)).affectedRows).toBe(1);
      return { project: p.rows[0].id, task: t.rows[0].id };
    });
    await as(BOB, async () => {
      for (const t of ["wf_projects", "wf_tasks", "wf_steps", "wf_events", "wf_approvals", "wf_memory", "wf_settings"]) expect((await db.query(`select * from public.${t}`)).rows, t).toHaveLength(0);
      await expect(db.query(`insert into public.wf_projects (name, repo) values ('Mine', 'bob/repo')`)).rejects.toThrow(/row-level security/);
      expect((await db.query(`update public.wf_approvals set status = 'approved'`)).affectedRows).toBe(0);
      expect((await db.query(`update public.wf_settings set settings = '{}'`)).affectedRows).toBe(0);
      await expect(db.query(`insert into public.wf_events (task_id, type, message) values ('${ids.task}', 'forged', 'x')`)).rejects.toThrow(/row-level security/);
    });
    await db.exec(`insert into public.admins (user_id) values ('${BOB}')`);
    await as(BOB, async () => {
      // A second operator still can't see the first operator's tasks.
      expect((await db.query("select * from public.wf_tasks")).rows).toHaveLength(0);
      await expect(db.query(`insert into public.wf_tasks (user_id, project_id, title, objective) values ('${ALICE}', '${ids.project}', 'x', 'y')`)).rejects.toThrow(/row-level security/);
    });
    await db.exec(`delete from public.admins where user_id = '${BOB}'`);
    await as(ALICE, async () => {
      await db.query(`delete from public.wf_projects where id = '${ids.project}'`);
      expect((await db.query("select * from public.wf_steps")).rows).toHaveLength(0);
    });
  });
});

describe("message order", () => {
  it("numbers messages in insert order, so a question sorts before its reply even with the same created_at", async () => {
    await as(ALICE, async () => {
      const c = await db.query<{ id: string }>("insert into public.conversations (title) values ('Order') returning id");
      const conv = c.rows[0]!.id;
      // One statement, one transaction time: both rows share created_at.
      await db.query("insert into public.messages (conversation_id, role, content) values ($1, 'user', 'q1'), ($1, 'assistant', 'a1'), ($1, 'user', 'q2'), ($1, 'assistant', 'a2')", [conv]);
      const same = await db.query<{ n: number }>("select count(distinct created_at)::int as n from public.messages where conversation_id = $1", [conv]);
      expect(same.rows[0]!.n).toBe(1);
      // Newest first with a limit, then reversed — how getConversation reads them.
      const r = await db.query<{ content: string }>("select content from public.messages where conversation_id = $1 order by created_at desc, seq desc limit 3", [conv]);
      expect(r.rows.map((x) => x.content).reverse()).toEqual(["a1", "q2", "a2"]);
      await expect(db.query("insert into public.messages (conversation_id, role, content, seq) values ($1, 'user', 'x', 1)", [conv])).rejects.toThrow();
    });
  });
});
