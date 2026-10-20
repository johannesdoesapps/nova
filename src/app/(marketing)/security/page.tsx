import Link from "next/link";
import { CtaBand } from "@/components/marketing/parts";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Security & data",
  description:
    "How Orbis stores your conversations and code, which AI providers receive your messages, what agents and connected apps may do, how code runs in isolation, and what you control.",
  path: "/security",
});

const SECTIONS: { id: string; title: string; points: React.ReactNode[] }[] = [
  {
    id: "accounts",
    title: "Accounts and sign-in",
    points: [
      "Accounts are managed by Supabase Auth. Orbis never stores your password; Supabase keeps only a secure hash of it.",
      "Google sign-in, where enabled, uses Google's own sign-in page — Orbis never sees your Google password.",
      "The site is served over HTTPS only, with security headers that stop other sites from framing it.",
    ],
  },
  {
    id: "storage",
    title: "What Orbis stores",
    points: [
      "Your conversations, custom agents, missions, Council and Arena sessions, code projects and their files, so you can come back to them.",
      "For each coding agent run: your request, an activity log of what it read, ran and changed, and each changed file's content before and after the run, so you can review and revert it.",
      "A usage record for each AI request: the model, token counts, estimated cost and the first part of the prompt and reply (up to 4,000 and 8,000 characters). These records enforce your plan limits. For code you run from chat, only the language and exit code are kept.",
      "Everything is stored in a Postgres database with row-level security: signed-in users can read only their own data. The people who operate this site can access the database for maintenance.",
    ],
  },
  {
    id: "providers",
    title: "Where your messages go",
    points: [
      "To answer you, your message and the conversation so far are sent to the provider of the model that replies: Anthropic for Claude and OpenAI for GPT on tryorbis.app (and Google, xAI or DeepSeek if those models are switched on). Their own terms and data policies apply to that processing.",
      "Every reply names the model that wrote it, so you always know which provider received your message. The coding agent's steps are sent to the model it uses in the same way, including the parts of your project it reads.",
      "When you connect an app and chat searches it, your search goes to that app, and what it returns is sent to the model that answers.",
      "Live web search isn't enabled on this site yet. When it is, search queries will be sent to the search provider.",
    ],
  },
  {
    id: "agents",
    title: "What agents can and can't do",
    points: [
      "Chat agents, Council, Arena and Mission Control write, explain, plan and review inside Orbis. They don't send emails, make purchases or change your accounts or systems. In Mission Control, only you can mark tasks complete.",
      "The coding agent edits files in your Orbis project and runs commands on that project's isolated computer. Tests, builds, installs and read-only commands run on their own; any other command waits for your approval; some are never run (deleting the whole project, sudo, publishing packages, deploying, git push, piping downloads into a shell). By default it shows you its plan before changing anything, and you can stop it at any time.",
      "Pushing to GitHub happens only when you press Push to GitHub and confirm. It creates a new branch and never writes to an existing one.",
      "The Security Team scans a website only after you prove you own it, never follows redirects to other domains, and never reaches private network addresses. It doesn't apply fixes for you.",
    ],
  },
  {
    id: "connectors",
    title: "Connected apps",
    points: [
      "Apps connect through their own sign-in (OAuth). Orbis requests the narrowest permissions a feature needs, and writing to an app is a separate switch that starts off.",
      "Access tokens are encrypted on the server with a key only the server holds, tied to your account and that app, and are never sent to your browser.",
      "Any change the AI proposes in a connected app — a draft email, a calendar event, a message — is shown to you first and happens only after you confirm it. Each confirmed action is logged in your account.",
      "Disconnecting an app deletes its stored access and, where the app supports it, revokes it.",
    ],
  },
  {
    id: "code",
    title: "Code execution",
    points: [
      "Code you run from a chat reply runs in a fresh, short-lived cloud computer with no network access and a 30-second limit, and is discarded afterwards.",
      "A Code project's computer runs only while you (or its agent) use it, in blocks of workspace time. It can reach npm and PyPI to install packages and nothing else, and none of Orbis's own keys or credentials are inside it. Stopping it discards it; your files are saved to your account.",
      "A project's live preview has a public address while its computer is on. Don't put secrets in your project.",
      "The Autonomous Developer (private preview, administrators only) runs a repository's own checks in an isolated sandbox. Network access is cut off after dependencies install, plans need human approval, and nothing is pushed to your repository.",
    ],
  },
  {
    id: "control",
    title: "Your control",
    points: [
      "Delete or archive any conversation from the sidebar. Delete a code project, and its files and agent runs go with it.",
      "Revert any coding agent run, or a single file it changed, from the Changes panel.",
      "Disconnect any connected app from Connectors at any time.",
      "Account deletion isn't self-service yet. Until it is, email support@tryorbis.app and your account and its data are deleted within 30 days.",
      "Orbis shows no advertising.",
    ],
  },
];

export default function SecurityPage() {
  return (
    <>
      <article className="mx-auto max-w-3xl px-5 pt-16 pb-6 sm:px-8 sm:pt-20">
        <h1 className="text-balance font-serif text-[44px] leading-[1.05] tracking-[-0.01em] text-fg sm:text-[56px]">Security &amp; data</h1>
        <p className="mt-5 text-[17px] leading-relaxed text-muted">
          Plain answers about what Orbis stores, who processes your messages and what its agents are allowed to do. This page describes how the product works today.
        </p>
        <nav aria-label="On this page" className="mt-8 rounded-2xl border border-border bg-panel p-5">
          <h2 className="text-sm font-medium text-fg">On this page</h2>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="text-sm text-muted hover:text-fg">{s.title}</a>
              </li>
            ))}
          </ul>
        </nav>
        {SECTIONS.map((s) => (
          <section key={s.id} aria-labelledby={s.id} className="mt-12 scroll-mt-24">
            <h2 id={s.id} className="text-2xl font-medium text-fg">{s.title}</h2>
            <ul className="mt-4 list-disc space-y-3 pl-5 text-[15px] leading-relaxed text-muted marker:text-muted">
              {s.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </section>
        ))}
        <p className="mt-12 text-sm text-muted">
          This page explains how Orbis works. The formal documents are our{" "}
          <Link href="/privacy" className="underline underline-offset-4 hover:text-fg">Privacy Policy</Link> and{" "}
          <Link href="/terms" className="underline underline-offset-4 hover:text-fg">Terms of Service</Link>. See also{" "}
          <Link href="/features/security-agents" className="underline underline-offset-4 hover:text-fg">the Security Team</Link> for checking your own site and code.
        </p>
      </article>
      <CtaBand />
    </>
  );
}
