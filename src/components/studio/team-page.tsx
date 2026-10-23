"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Check, Copy, Loader2, Trash2, UserPlus, Users } from "lucide-react";
import { useApp } from "@/components/layout/app-context";
import { jsonFetch } from "@/hooks/use-ndjson";
import { cn } from "@/lib/utils";
import { StudioHeader } from "./frame";
import { Segmented } from "./ui";

type Price = { label: string; month: number; year: number };
type Offer = { pro: Price; max: Price; minSeats: number; maxSeats: number; paymentsReady: boolean };
type Team = {
  id: string;
  name: string;
  plan: "pro" | "max";
  planLabel: string;
  interval: "month" | "year";
  seats: number;
  status: string;
  seatPriceUsd: number | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  disputed: boolean;
  role: "owner" | "member";
};
type Member = { user_id: string; email: string; role: "owner" | "member"; joined_at: string };
type Invite = { id: string; email: string; created_at: string; expires_at: string };
type State = { team: Team | null; members?: Member[]; invites?: Invite[]; offer: Offer };

const btn = "inline-flex h-10 items-center justify-center gap-1.5 rounded-full px-5 text-[14px] font-medium transition disabled:opacity-40 [&_svg]:h-4 [&_svg]:w-4";
const primary = cn(btn, "bg-s-accent text-s-accent-ink hover:brightness-110");
const quiet = cn(btn, "border border-s-line-strong hover:bg-s-hover");
const field = "h-10 w-full rounded-xl border border-s-line bg-transparent px-3 text-[14px] outline-none placeholder:text-s-ink-3 focus:border-s-line-strong";
const ACTIVE = ["active", "trialing", "past_due"];

/**
 * The Team plan: one subscription pays for several seats, and every member gets the team's plan (Pro or Max) with
 * their own allowance. The owner starts the team, invites people by email, changes seats and manages billing.
 */
export function TeamPage() {
  const { user } = useApp();
  const params = useSearchParams();
  const [state, setState] = useState<State | "error" | null>(null);
  const [reload, setReload] = useState(0);
  const sessionId = params.get("session_id");
  const [confirming, setConfirming] = useState(!!sessionId);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    const load = () => jsonFetch<State>("/api/team").then((j) => alive && setState(j));
    // Back from Stripe: confirm the payment now so the team is active straight away.
    (sessionId
      ? jsonFetch("/api/billing/sync", { method: "POST", body: JSON.stringify({ sessionId }) })
          .catch(() => null)
          .finally(() => alive && setConfirming(false))
      : Promise.resolve()
    )
      .then(load)
      .catch(() => alive && setState("error"));
    return () => {
      alive = false;
    };
  }, [user, reload, sessionId]);

  const refresh = () => setReload((n) => n + 1);
  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Team</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[880px] px-4 pb-24 pt-2 sm:px-8">
          <h2 className="font-serif text-[clamp(30px,5vw,40px)] leading-tight">Team</h2>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-s-ink-3">
            One subscription for several people. Each seat gets the team’s plan with its own allowance; allowances aren’t shared. The owner pays, invites people and changes seats.
          </p>
          {!user ? (
            <section className="glass mt-6 rounded-[22px] p-5">
              <p className="text-[14px] text-s-ink-2">Sign in to start or join a team.</p>
              <Link href="/login?next=/team" className={cn(primary, "mt-4")}>
                Sign in
              </Link>
            </section>
          ) : confirming || state === null ? (
            <div className="mt-6 space-y-2" role="status" aria-label="Loading">
              <div className="s-skeleton h-4 w-1/2" />
              <div className="s-skeleton h-24 w-full" />
            </div>
          ) : state === "error" ? (
            <p className="mt-6 text-[14px] text-s-ink-2">Your team couldn’t load. Refresh the page to try again.</p>
          ) : state.team && ACTIVE.includes(state.team.status) ? (
            <TeamView state={state as State & { team: Team }} onChanged={refresh} />
          ) : (
            <StartTeam offer={state.offer} pending={state.team} />
          )}
        </div>
      </div>
    </>
  );
}

function StartTeam({ offer, pending }: { offer: Offer; pending: Team | null }) {
  const [name, setName] = useState(pending?.name ?? "");
  const [plan, setPlan] = useState<"pro" | "max">(pending?.plan ?? "pro");
  const [interval, setInterval] = useState<"month" | "year">(pending?.interval ?? "month");
  const [seats, setSeats] = useState(Math.max(offer.minSeats, 3));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = offer[plan][interval];
  const total = price * seats;
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const j = await jsonFetch<{ url: string }>("/api/team/checkout", { method: "POST", body: JSON.stringify({ name: name.trim(), plan, interval, seats }) });
      window.location.assign(j.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The team couldn't be started.");
      setBusy(false);
    }
  };
  return (
    <section aria-labelledby="start-team" className="glass mt-6 rounded-[22px] p-4 sm:p-6">
      <h3 id="start-team" className="text-[16px] font-semibold">
        Start a team
      </h3>
      <p className="mt-1 text-[13.5px] text-s-ink-3">You’ll be the owner and take one seat. Invite the others after paying.</p>
      {pending && pending.status === "canceled" && <p className="mt-2 text-[13px] text-s-ink-2">Your team’s subscription has ended. Start it again below.</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block text-[13px] font-medium">
          Team name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="e.g. Acme design team" className={cn(field, "mt-1.5 font-normal")} />
        </label>
        <label className="block text-[13px] font-medium">
          Seats ({offer.minSeats}–{offer.maxSeats})
          <input
            type="number"
            min={offer.minSeats}
            max={offer.maxSeats}
            value={seats}
            onChange={(e) => setSeats(Math.max(offer.minSeats, Math.min(offer.maxSeats, Math.round(Number(e.target.value) || offer.minSeats))))}
            className={cn(field, "mt-1.5 font-normal")}
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Segmented
          label="Plan for every seat"
          value={plan}
          onChange={setPlan}
          options={[
            { value: "pro", label: offer.pro.label },
            { value: "max", label: offer.max.label },
          ]}
        />
        <Segmented
          label="Billing"
          value={interval}
          onChange={setInterval}
          options={[
            { value: "month", label: "Monthly" },
            { value: "year", label: "Yearly" },
          ]}
        />
      </div>
      <p className="mt-4 text-[14px]">
        <span className="font-semibold">
          ${total.toLocaleString("en-US")} {interval === "month" ? "a month" : "a year"}
        </span>{" "}
        <span className="text-s-ink-3">
          ({seats} seats × ${price.toLocaleString("en-US")}, plus any tax shown at checkout)
        </span>
      </p>
      {error && (
        <p className="mt-3 text-[13px] text-s-danger" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" className={primary} disabled={busy || !name.trim() || !offer.paymentsReady} onClick={() => void start()}>
          {busy ? <Loader2 className="animate-spin" /> : <Users />} Continue to payment
        </button>
        {!offer.paymentsReady && <span className="text-[13px] text-s-ink-3">Payments aren’t switched on yet.</span>}
      </div>
    </section>
  );
}

function TeamView({ state, onChanged }: { state: State & { team: Team }; onChanged: () => void }) {
  const { user } = useApp();
  const { team } = state;
  const owner = team.role === "owner";
  const members = state.members ?? [];
  const invites = state.invites ?? [];
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
    }
  };
  const renews = team.periodEnd ? new Date(team.periodEnd).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : null;
  return (
    <>
      <section aria-labelledby="team-summary" className="glass mt-6 rounded-[22px] p-4 sm:p-6">
        <h3 id="team-summary" className="text-[18px] font-semibold">
          {team.name}
        </h3>
        <p className="mt-1 text-[13.5px] text-s-ink-2">
          {team.planLabel} for every member · {members.length} of {team.seats} seats used{invites.length ? ` · ${invites.length} invited` : ""}
          {renews ? ` · ${team.cancelAtPeriodEnd ? "ends" : "renews"} ${renews}` : ""}
        </p>
        {team.status === "past_due" && (
          <p className="mt-2 text-[13px] text-s-ink">
            The last payment didn’t go through. {owner ? "Update the card under Billing to keep the team’s plan." : "The team owner has been asked to update the card."}
          </p>
        )}
        {team.disputed && <p className="mt-2 text-[13px] text-s-ink">A payment for this team is disputed, so the team’s plan is paused until it’s settled.</p>}
        {owner && <OwnerTools team={team} inUse={members.length + invites.length} onChanged={onChanged} />}
      </section>

      <section aria-labelledby="team-members" className="mt-6">
        <h3 id="team-members" className="text-[15px] font-semibold">
          Members
        </h3>
        <ul className="mt-2 divide-y divide-s-line rounded-[18px] border border-s-line">
          {members.map((m) => (
            <li key={m.user_id} className="flex items-center gap-3 px-4 py-3 text-[13.5px]">
              <span className="min-w-0 flex-1 truncate">{m.email}</span>
              <span className="text-[12.5px] text-s-ink-3">{m.role === "owner" ? "Owner" : "Member"}</span>
              {owner && m.role !== "owner" && (
                <button
                  type="button"
                  className="rounded-lg p-1.5 text-s-ink-3 hover:bg-s-hover hover:text-s-ink"
                  aria-label={`Remove ${m.email}`}
                  onClick={() => void act(() => jsonFetch("/api/team/members", { method: "DELETE", body: JSON.stringify({ userId: m.user_id }) }))}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
              {!owner && m.user_id === user?.id && (
                <button
                  type="button"
                  className="text-[12.5px] text-s-ink-2 underline-offset-2 hover:underline"
                  onClick={() => void act(() => jsonFetch("/api/team/members", { method: "DELETE", body: JSON.stringify({ userId: m.user_id }) }))}
                >
                  Leave team
                </button>
              )}
            </li>
          ))}
        </ul>
        {owner && invites.length > 0 && (
          <>
            <h4 className="mt-5 text-[13.5px] font-medium">Invited</h4>
            <ul className="mt-2 divide-y divide-s-line rounded-[18px] border border-s-line">
              {invites.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-4 py-3 text-[13.5px]">
                  <span className="min-w-0 flex-1 truncate text-s-ink-2">{i.email}</span>
                  <button
                    type="button"
                    className="text-[12.5px] text-s-ink-2 underline-offset-2 hover:underline"
                    onClick={() => void act(() => jsonFetch("/api/team/invites", { method: "DELETE", body: JSON.stringify({ id: i.id }) }))}
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && (
          <p className="mt-3 text-[13px] text-s-danger" role="alert">
            {error}
          </p>
        )}
      </section>
    </>
  );
}

function OwnerTools({ team, inUse, onChanged }: { team: Team; inUse: number; onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [seats, setSeats] = useState(team.seats);
  const [link, setLink] = useState<{ link: string; emailed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-5 space-y-5 border-t border-s-line pt-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run("invite", async () => {
            const j = await jsonFetch<{ link: string; emailed: boolean }>("/api/team/invites", { method: "POST", body: JSON.stringify({ email: email.trim() }) });
            setLink(j);
            setEmail("");
            onChanged();
          });
        }}
      >
        <label htmlFor="invite-email" className="text-[13px] font-medium">
          Invite someone
        </label>
        <div className="mt-1.5 flex flex-wrap gap-2">
          <input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className={cn(field, "min-w-0 flex-1")} />
          <button type="submit" className={quiet} disabled={busy !== null || !email.includes("@") || inUse >= team.seats}>
            {busy === "invite" ? <Loader2 className="animate-spin" /> : <UserPlus />} Invite
          </button>
        </div>
        {inUse >= team.seats && <p className="mt-1.5 text-[12.5px] text-s-ink-3">All seats are in use. Add seats below to invite more people.</p>}
        {link && (
          <div className="mt-2 rounded-xl border border-s-line p-3 text-[12.5px] text-s-ink-2">
            {link.emailed ? "We emailed the invitation. You can also send this link yourself:" : "Send this link to them (it works for 14 days, only for that email address):"}
            <div className="mt-1.5 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-s-ink">{link.link}</code>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-s-line-strong px-2.5 hover:bg-s-hover"
                onClick={() => {
                  void navigator.clipboard?.writeText(link.link).then(() => setCopied(true));
                }}
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}
      </form>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-[13px] font-medium">
          Seats
          <input
            type="number"
            min={Math.max(2, inUse)}
            max={150}
            value={seats}
            onChange={(e) => setSeats(Math.round(Number(e.target.value) || team.seats))}
            className={cn(field, "mt-1.5 w-28 font-normal")}
          />
        </label>
        <button
          type="button"
          className={quiet}
          disabled={busy !== null || seats === team.seats || seats < Math.max(2, inUse)}
          onClick={() =>
            void run("seats", async () => {
              await jsonFetch("/api/team/seats", { method: "PATCH", body: JSON.stringify({ seats }) });
              onChanged();
            })
          }
        >
          {busy === "seats" ? <Loader2 className="animate-spin" /> : null} Update seats
        </button>
        <button
          type="button"
          className={quiet}
          disabled={busy !== null}
          onClick={() =>
            void run("portal", async () => {
              const j = await jsonFetch<{ url: string }>("/api/team/portal", { method: "POST" });
              window.location.assign(j.url);
            })
          }
        >
          Billing and invoices
        </button>
      </div>
      <p className="text-[12.5px] text-s-ink-3">Added seats are charged now for the rest of the period; removed seats are credited to the next invoice.</p>
      {error && (
        <p className="text-[13px] text-s-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Accept an invitation from its link. */
export function TeamJoin() {
  const { user } = useApp();
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "joining" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const join = async () => {
    setState("joining");
    setError(null);
    try {
      await jsonFetch("/api/team/join", { method: "POST", body: JSON.stringify({ token }) });
      router.push("/team");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The invitation couldn't be accepted.");
      setState("error");
    }
  };
  return (
    <>
      <StudioHeader>
        <h1 className="text-[14px] font-medium text-s-ink-2">Join a team</h1>
      </StudioHeader>
      <div className="s-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[640px] px-4 pb-24 pt-8 sm:px-8">
          <section className="glass rounded-[22px] p-5 sm:p-6">
            <h2 className="text-[20px] font-semibold">You’re invited to a team on Orbis</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-s-ink-2">Joining gives you the team’s plan with your own allowance. The team owner can see your email address, not your chats.</p>
            {!token ? (
              <p className="mt-4 text-[14px] text-s-ink-2">This link is missing its invitation code. Ask the team owner to send it again.</p>
            ) : !user ? (
              <Link href={`/login?next=${encodeURIComponent(`/team/join?token=${token}`)}`} className={cn(primary, "mt-5")}>
                Sign in with the invited email to join
              </Link>
            ) : (
              <button type="button" className={cn(primary, "mt-5")} disabled={state === "joining"} onClick={() => void join()}>
                {state === "joining" ? <Loader2 className="animate-spin" /> : <Users />} Join the team as {user.email}
              </button>
            )}
            {error && (
              <p className="mt-3 text-[13px] text-s-danger" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
