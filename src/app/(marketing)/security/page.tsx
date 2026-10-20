import Link from "next/link";
import { CtaBand } from "@/components/marketing/parts";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Security & data",
  description:
    "How Orbis stores your conversations, which AI providers receive your messages, what agents may and may not do, how code runs in isolated sandboxes, and how to delete your data.",
  path: "/security",
});

const SECTIONS: { id: string; title: string; points: React.ReactNode[] }[] = [
  {
    id: "accounts",
    title: "Accounts and sign-in",
    points: [
      "Accounts are managed by Supabase Auth. Passwords are never stored by Orbis itself; Supabase stores only a secure hash.",
      "Google sign-in, when enabled, uses Google's own sign-in page — Orbis never sees your Google password.",
      "The site is served over HTTPS only, with security headers that stop it being framed by other sites.",
    ],
  },
  {
    id: "storage",
    title: "What Orbis stores",
    points: [
      "Your conversations, custom agents, missions, Council and Arena sessions and projects, so you can come back to them.",
      "A usage record for each AI request: the model, token counts, estimated cost and the first part of the prompt and reply (up to 4,000 and 8,000 characters). These records enforce your plan limits.",
      "Everything is stored in a Postgres database with row-level security: signed-in users can read only their own data. The people who operate this site can access the database for maintenance.",
    ],
  },
  {
    id: "providers",
    title: "Where your messages go",
    points: [
      "To answer you, your message and the conversation so far are sent to the provider of the model that replies: Anthropic for Claude, OpenAI for GPT, Google for Gemini and xAI for Grok (Gemini and Grok only when the site has them switched on). Their own terms and data policies apply to that processing.",
      "Every reply names the model that wrote it, so you always know which provider received your message.",
      "Live web search isn't enabled on this site yet. When it is, search queries will be sent to the search provider.",
    ],
  },
  {
    id: "agents",
    title: "What agents can and can't do",
    points: [
      "Assistants and agents write, explain, plan and review inside Orbis. They don't send emails, make purchases, or change your accounts or systems.",
      "In Mission Control the AI drafts tasks but can't mark them complete — only you can.",
      "The Security Team scans a website only after you prove you own it, never follows redirects to other domains, and never reaches private network addresses. It doesn't apply fixes for you.",
    ],
  },
  {
    id: "code",
    title: "Code execution",
    points: [
      "The general assistant and the Coding Agent never run code.",
      "The Autonomous Developer (private preview, administrators only) runs a repository's own checks in an isolated cloud sandbox. Network access is cut off after dependencies install, each task has a spending budget, plans need human approval, and nothing is pushed to your repository.",
    ],
  },
  {
    id: "control",
    title: "Your control",
    points: [
      "Delete any conversation from the sidebar at any time.",
      "Account deletion isn't self-service yet. Until it is, the site operator can delete an account and its data on request.",
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
          A formal privacy policy and terms of service are being prepared and will be linked from every page once published. See also{" "}
          <Link href="/features/security-agents" className="underline underline-offset-4 hover:text-fg">the Security Team</Link> for checking your own site and code.
        </p>
      </article>
      <CtaBand />
    </>
  );
}
