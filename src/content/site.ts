/**
 * Public-site content: feature pages, guides, pricing and FAQ. Everything here
 * describes what NOVA does today; anything not generally available carries a
 * status, and limits are stated next to the feature they apply to.
 */
import { PLANS } from "@/lib/plans";

export type Status = "available" | "beta" | "preview" | "planned";
export const STATUS_LABEL: Record<Status, string> = {
  available: "Available",
  beta: "Beta",
  preview: "Private preview",
  planned: "Planned",
};

export interface Feature {
  slug: string;
  name: string;
  /** <title>: what someone would search for. */
  title: string;
  description: string;
  status: Status;
  tagline: string;
  audience: string;
  /** Where to try it inside the app. */
  appPath: string;
  appLabel: string;
  highlights: { title: string; text: string }[];
  steps: string[];
  limits: string[];
  guide?: string;
}

export const FEATURES: Feature[] = [
  {
    slug: "ai-assistant",
    name: "AI Assistant",
    title: "AI Assistant with Claude and GPT models",
    description:
      "Chat with Claude and GPT models in one workspace. NOVA's Smart Router picks a suitable model for each question and tells you why, with saved history and usage you can see.",
    status: "available",
    tagline: "One chat for several leading AI models — with the model and the reason it was chosen shown on every reply.",
    audience: "Anyone who writes, researches or learns with AI and wants to use more than one model without juggling subscriptions.",
    appPath: "/chat",
    appLabel: "Open the assistant",
    highlights: [
      { title: "Smart Router", text: "Auto mode chooses a model for each message — Quick, Deep, Research or Coding — and shows the reason under the reply. You can always pick a model yourself." },
      { title: "Claude and GPT in one place", text: "Switch between Claude (Anthropic) and GPT (OpenAI) models from the same composer. Your conversation history stays in one list." },
      { title: "Saved, searchable history", text: "Conversations are saved to your account. Rename, delete or move them into a project from the sidebar." },
      { title: "Files and voice", text: "Attach files by button, drag-and-drop or paste, and dictate with voice input where your browser supports it." },
      { title: "Command palette", text: "Press Ctrl+K (⌘K on Mac) to jump to a conversation, switch model or go to another part of NOVA." },
      { title: "Visible usage", text: "Every reply shows which model answered, plus an estimated cost where the model's price is known. Your plan usage is always visible." },
    ],
    steps: ["Create a free account.", "Ask anything — leave the model on Auto or choose one.", "Read why the model was chosen, then continue, retry with another model or save the answer."],
    limits: [
      "Live web search and the Truth Layer's source checks need a search provider that this site hasn't enabled yet; without it, answers don't cite live sources and claims are marked “not verified”.",
      "Usage is limited per plan (see Pricing). Larger models use more of your allowance than low-cost ones.",
    ],
    guide: "getting-started",
  },
  {
    slug: "ai-coding-assistant",
    name: "AI Coding Assistant",
    title: "AI Coding Assistant for explaining, fixing and reviewing code",
    description:
      "Debug, explain and review code with NOVA's Coding Agent and Coding mode. It finds the root cause first, writes code in clear blocks, and never claims to have run code it hasn't.",
    status: "available",
    tagline: "Root cause first, then the fix — from a coding assistant that's honest about what it hasn't run.",
    audience: "Developers and students who want a second pair of eyes on bugs, code reviews and unfamiliar codebases.",
    appPath: "/agents",
    appLabel: "Open the Coding Agent",
    highlights: [
      { title: "Coding Agent", text: "A built-in agent tuned for code: explains the root cause before the fix, keeps code in fenced blocks and states assumptions." },
      { title: "Coding mode in the Smart Router", text: "Auto · Coding narrows the choice to models suited to programming tasks." },
      { title: "Paste or attach files", text: "Share snippets or whole files; the agent analyses what you give it." },
      { title: "Second opinions", text: "Ask the same question to several models side by side with Nova Arena or Nova Council and compare the answers." },
    ],
    steps: ["Open Agents and choose the Coding Agent (or pick Auto · Coding in chat).", "Paste the error, the code and what you expected.", "Review the explanation and the proposed change before using it."],
    limits: [
      "The assistant does not run your code or tests. Check suggestions before you use them.",
      "For automated changes that are actually built and tested, see the Autonomous Developer (private preview).",
    ],
    guide: "custom-agents",
  },
  {
    slug: "ai-agents",
    name: "Customizable AI Agents",
    title: "Customizable AI Agents — built-in and your own",
    description:
      "Use NOVA's built-in Research, Coding, Writing, Data Analyst, Creative and General agents, or create your own with custom instructions, default model and starter prompts.",
    status: "available",
    tagline: "Specialised assistants with their own instructions, tools and history — use ours or build your own.",
    audience: "People who repeat the same kind of task and want an assistant that already knows how they like it done.",
    appPath: "/agents",
    appLabel: "Browse agents",
    highlights: [
      { title: "Six built-in agents", text: "Research, Coding, Writing, Data Analyst, Creative and General Assistant — each with its own instructions, temperature and starter prompts." },
      { title: "Your own agents", text: "Write instructions (20–8,000 characters), pick an icon, colour, default model and up to four starter prompts." },
      { title: "Customise a copy", text: "Start from any built-in agent and change what you need; the original stays untouched." },
      { title: "Separate history", text: "Each agent keeps its own conversations next to your general chats." },
    ],
    steps: ["Open Agents.", "Pick a built-in agent, or choose “Create agent” and describe how it should work.", "Chat with it; edit its instructions whenever you want."],
    limits: ["Agents use the same models and usage limits as the assistant.", "Agents can't take actions outside NOVA."],
    guide: "custom-agents",
  },
  {
    slug: "multi-model",
    name: "Council & Arena",
    title: "Compare AI models side by side — Nova Council and Nova Arena",
    description:
      "Ask several AI models the same question. Nova Council combines their answers into one synthesis with agreements and disagreements; Nova Arena lets you compare them blind and pick a winner.",
    status: "available",
    tagline: "Don't trust one model's answer — see where several agree, and where they don't.",
    audience: "Anyone making a decision from AI output who wants a cross-check before relying on it.",
    appPath: "/council",
    appLabel: "Open Nova Council",
    highlights: [
      { title: "Council", text: "Each model answers independently; in Deep mode they review each other's anonymised answers; a chair model writes a synthesis listing agreements, disagreements and what still needs checking." },
      { title: "Arena", text: "Blind mode hides model names until you reveal them. Rate answers, pick a winner, or ask a model to improve its answer." },
      { title: "Every step visible", text: "Model, latency, tokens and estimated cost are shown for each step. A failed model doesn't stop the others." },
    ],
    steps: ["Open Council or Arena.", "Choose two or more models and ask your question.", "Read the synthesis or compare the answers, then save the session."],
    limits: ["Each model's answer counts against your usage, so a Council costs more than a single reply."],
    guide: "council-and-arena",
  },
  {
    slug: "mission-control",
    name: "Mission Control",
    title: "Mission Control — turn goals into AI-drafted plans",
    description:
      "Turn a goal into an editable plan of milestones and tasks, and let AI draft the tasks it can help with. You stay in control: nothing is saved or completed without you.",
    status: "available",
    tagline: "From a goal to a plan you can work through — with AI drafting the parts it can.",
    audience: "Founders, students and teams planning projects who want structure without a heavy project-management tool.",
    appPath: "/missions",
    appLabel: "Open Mission Control",
    highlights: [
      { title: "Plan from a goal", text: "Describe what you want to achieve; NOVA proposes milestones and tasks with priorities, which you can edit before saving." },
      { title: "AI drafts, you decide", text: "Tasks marked “AI can draft this” can be drafted by any model. Drafts are saved to the mission and every attempt is logged." },
      { title: "You mark progress", text: "The AI never marks tasks complete and is told it can't take real-world actions." },
    ],
    steps: ["Open Mission Control and describe your goal.", "Edit the proposed plan and press Create.", "Ask AI to draft tasks, edit the drafts, and tick tasks off yourself."],
    limits: ["Mission Control plans and drafts; it does not send emails, book things or act outside NOVA."],
    guide: "mission-control",
  },
  {
    slug: "security-agents",
    name: "Security Team",
    title: "AI Security Agents for website, log and code checks",
    description:
      "Three security agents — Sentinel (website checks), Threat Hunter (log analysis) and Code Guardian (code and dependency audits) — that use real scanners and explain what they find.",
    status: "beta",
    tagline: "Real scanners find the issues; AI explains them and proposes fixes you can review.",
    audience: "Developers and site owners who want a quick, explained security check of their own site, logs or code.",
    appPath: "/agents/security",
    appLabel: "Open the Security Team",
    highlights: [
      { title: "Nova Sentinel", text: "Checks a website you own for HTTPS, security headers, cookies, CORS and exposed files — only after you prove ownership." },
      { title: "Nova Threat Hunter", text: "Analyses web and SSH logs you upload for suspicious patterns, with IP reputation when configured." },
      { title: "Nova Code Guardian", text: "Scans code for leaked secrets and risky patterns, and checks dependencies against the OSV vulnerability database." },
      { title: "Findings you can trust", text: "Every finding has severity, confidence, evidence and a fix. AI reviews only count when the quoted code really exists in your files." },
    ],
    steps: ["Open Security Team.", "Verify a site you own, upload logs, or point Code Guardian at code.", "Review findings, then export a report."],
    limits: [
      "Website scans require proof that you own the site, and never reach private network addresses.",
      "It is a point-in-time check, not continuous monitoring, and it never applies patches for you.",
    ],
    guide: "security-team",
  },
  {
    slug: "autonomous-developer",
    name: "Autonomous Developer",
    title: "Autonomous Developer — AI agents that plan, code and test",
    description:
      "NOVA's AI Workforce plans a code change, writes it in an isolated sandbox, runs the project's real type checks, lint, tests and build, and reports what passed. Currently a private preview.",
    status: "preview",
    tagline: "Agents that plan, write and test a change — and only call it done when the checks pass.",
    audience: "NOVA's own team today. Broader access will be announced; it isn't open for sign-up yet.",
    appPath: "/workforce",
    appLabel: "Open Workforce (admins)",
    highlights: [
      { title: "A team of agents", text: "An Archaeologist maps the code, an Architect plans, a Builder writes the change, QA runs the checks, a Reviewer and a Security agent review it." },
      { title: "Isolated sandbox", text: "Each task runs in its own sandbox with network access cut off after dependencies install." },
      { title: "Human approval", text: "You approve the plan before any code is written; high-risk plans always need a person." },
      { title: "Verified, not just generated", text: "A task is only marked verified when the project's real checks pass. Budgets cap spending per task." },
    ],
    steps: ["Register a GitHub repository.", "Describe the change and approve the plan.", "Review the verified diff and report; nothing is pushed for you."],
    limits: [
      "Private preview: available to the site's administrators only.",
      "Supports npm projects on GitHub. It does not open pull requests or push code yet.",
    ],
    guide: "autonomous-developer",
  },
];

export const featureBySlug = (slug: string) => FEATURES.find((f) => f.slug === slug);

export interface Guide {
  slug: string;
  title: string;
  /** Label for navigation lists. */
  short: string;
  description: string;
  feature?: string;
  sections: { heading: string; body: string[] }[];
}

export const GUIDES: Guide[] = [
  {
    slug: "getting-started",
    short: "Getting started",
    title: "Getting started with NOVA",
    description: "Create an account, ask your first question, choose a model and find your way around NOVA's workspace.",
    feature: "ai-assistant",
    sections: [
      { heading: "Create your account", body: ["Go to Sign up and enter your email address and a password of at least 8 characters. Once your account is ready you're taken to the chat.", "Every new account starts on the Free plan."] },
      { heading: "Ask your first question", body: ["Type in the composer at the bottom of the chat and press Enter. Shift+Enter adds a new line.", "Leave the model on Auto and NOVA picks one for you; the reason appears under the reply."] },
      { heading: "Choose a model yourself", body: ["Open the model menu in the composer to pick a specific Claude or GPT model, or a Smart Router mode: Quick for short questions, Deep for harder reasoning, Research for sourced answers, Coding for programming."] },
      { heading: "Find things quickly", body: ["Press Ctrl+K (⌘K on Mac) to open the command palette: jump to a past conversation, switch model, or go to Agents, Mission Control and the rest of NOVA.", "The sidebar lists your conversations by date. Use the menu next to a conversation to rename or delete it."] },
      { heading: "Know your limits", body: ["Each plan has a 5-hour and a weekly allowance. A message to a low-cost model uses 1 unit; larger models use more. When you're close to a limit, Auto prefers low-cost models and says so."] },
    ],
  },
  {
    slug: "choosing-a-model",
    short: "Choosing a model",
    title: "Choosing a model: Auto and the Smart Router modes",
    description: "How NOVA's Smart Router chooses a model, what Quick, Deep, Research and Coding modes do, and when to pick a model yourself.",
    feature: "ai-assistant",
    sections: [
      { heading: "What Auto does", body: ["Auto looks at your message and the models available on this site, then chooses one and shows why under the reply. It never picks a model that isn't configured."] },
      { heading: "The four modes", body: ["Quick favours fast, low-cost models for short questions.", "Deep favours models that reason more carefully, for analysis and harder problems.", "Research looks for sourced answers when web search is available, and says so when it isn't.", "Coding narrows the choice to models suited to programming."] },
      { heading: "When to choose a model yourself", body: ["Pick a specific model when you want consistent behaviour across a long conversation, or when you want to compare how two models handle the same prompt — Nova Arena makes that easier."] },
    ],
  },
  {
    slug: "custom-agents",
    short: "Custom agents",
    title: "Creating a custom AI agent",
    description: "Build an agent with your own instructions, default model and starter prompts, or customise a copy of a built-in agent.",
    feature: "ai-agents",
    sections: [
      { heading: "Start from a built-in agent", body: ["Open Agents and choose one of the six built-ins. Use “Customize a copy” to make an editable version; the original stays as it is."] },
      { heading: "Write good instructions", body: ["Say who the agent is for, what it should always do and what it should avoid. Instructions can be 20 to 8,000 characters.", "Concrete rules work better than adjectives: “Answer in under 150 words, then list sources” beats “be concise”."] },
      { heading: "Pick a default model and starters", body: ["Choose the model the agent uses by default — or Auto — and add up to four starter prompts that appear when you open it."] },
      { heading: "Use it", body: ["Each agent keeps its own conversation history. You can edit, duplicate or delete your custom agents at any time."] },
    ],
  },
  {
    slug: "council-and-arena",
    short: "Council & Arena",
    title: "Comparing models with Nova Council and Nova Arena",
    description: "When to use Council for a combined answer and Arena for a blind side-by-side comparison, and how each one works.",
    feature: "multi-model",
    sections: [
      { heading: "Council: one answer from several models", body: ["Choose two or more models and ask a question. Each answers independently. In Deep mode, each model then reviews the others' anonymised answers.", "A chair model writes a synthesis: where the models agree, where they disagree, and what still needs checking."] },
      { heading: "Arena: compare and choose", body: ["Arena shows the answers side by side. With Blind mode on, model names stay hidden until you reveal them, so you judge the answer, not the brand.", "Rate each answer, pick a winner, or ask one model to improve its answer."] },
      { heading: "Cost", body: ["Every model's answer counts against your usage, and each step shows its estimated cost, so you can decide when a cross-check is worth it."] },
    ],
  },
  {
    slug: "mission-control",
    short: "Mission Control",
    title: "Planning a project with Mission Control",
    description: "Turn a goal into milestones and tasks, let AI draft the tasks it can help with, and track progress yourself.",
    feature: "mission-control",
    sections: [
      { heading: "Describe the goal", body: ["Open Mission Control and describe what you want to achieve and by when. NOVA proposes milestones and tasks with priorities."] },
      { heading: "Edit before saving", body: ["Nothing is saved until you press Create. Rename, reorder, add or remove anything first."] },
      { heading: "Let AI draft", body: ["Tasks marked “AI can draft this” can be drafted by any model — an outline, an email, a checklist. Edit the draft and save it to the mission's notes."] },
      { heading: "You mark progress", body: ["Only you can mark a task complete. The AI is told it can't take actions outside NOVA."] },
    ],
  },
  {
    slug: "security-team",
    short: "Security checks",
    title: "Running a security check with the Security Team",
    description: "How to verify your website, analyse logs and audit code with Nova Sentinel, Threat Hunter and Code Guardian.",
    feature: "security-agents",
    sections: [
      { heading: "Prove you own the site", body: ["Before Sentinel scans a website, add it as a target and verify ownership with a file on the site or a DNS TXT record. Scans never follow redirects to other domains or reach private addresses."] },
      { heading: "Choose the right agent", body: ["Sentinel checks a live site's headers, cookies, HTTPS and exposed files.", "Threat Hunter analyses web-server or SSH logs you upload.", "Code Guardian scans code for secrets and risky patterns and checks dependencies against OSV.dev."] },
      { heading: "Read the findings", body: ["Each finding has a severity, a separate confidence level, the evidence, and a suggested fix. Re-check a finding after you fix it, then export a report."] },
      { heading: "What it doesn't do", body: ["It's a point-in-time check, not continuous monitoring, and it never applies changes for you."] },
    ],
  },
  {
    slug: "autonomous-developer",
    short: "Autonomous Developer",
    title: "How the Autonomous Developer works",
    description: "The steps NOVA's AI Workforce takes to plan, build and verify a code change, and the safeguards around it. Private preview.",
    feature: "autonomous-developer",
    sections: [
      { heading: "Status", body: ["The Autonomous Developer is a private preview available to the site's administrators. It isn't open for general sign-up yet."] },
      { heading: "From request to verified change", body: ["An Archaeologist agent maps the relevant code, an Architect writes a plan, and you approve it. A Builder then writes the change in an isolated sandbox and QA runs the project's own type checks, lint, tests and build. A Reviewer and a Security agent review the result.", "If a check fails, a Self-Heal agent tries a bounded number of repairs."] },
      { heading: "Safeguards", body: ["Every task has a spending and token budget. The sandbox loses network access after dependencies install. High-risk plans always need a person. A task only counts as verified when the real checks pass, and nothing is pushed to your repository."] },
    ],
  },
];

export const guideBySlug = (slug: string) => GUIDES.find((g) => g.slug === slug);

export const PRICING = {
  free: {
    name: PLANS.free.label,
    window: PLANS.free.windowUnits,
    weekly: PLANS.free.weeklyUnits,
  },
  pro: {
    name: PLANS.pro.label,
    price: PLANS.pro.priceUsd,
    window: PLANS.pro.windowUnits,
    weekly: PLANS.pro.weeklyUnits,
  },
};

export const FAQ: { q: string; a: string }[] = [
  { q: "What is NOVA?", a: "NOVA is a web workspace for working with AI: a multi-model assistant, specialised and custom agents, tools to compare models, a planner that turns goals into tasks, and security agents for checking your own site and code." },
  { q: "Which AI models does NOVA use?", a: "This site offers Claude models from Anthropic and GPT models from OpenAI, and can add Gemini (Google) and Grok (xAI). Each reply shows which model answered." },
  { q: "Is NOVA free?", a: `Yes. The Free plan includes ${PLANS.free.windowUnits} usage units per 5-hour window and ${PLANS.free.weeklyUnits} per week. A message to a low-cost model uses 1 unit; larger models use more. Pro costs $${PLANS.pro.priceUsd} per month and gives ten times the allowance.` },
  { q: "Do I need a credit card to sign up?", a: "No. You sign up with an email address and password and start on the Free plan." },
  { q: "What happens to my conversations?", a: "They're saved to your account so you can come back to them, and only you can read them. Your messages are sent to the AI provider of the model that answers them, which each reply names. See Security & data for details." },
  { q: "Can NOVA's agents take actions for me?", a: "No. NOVA's assistants and agents write, explain, plan and review. They don't send emails, make purchases or change your systems. The Autonomous Developer writes code changes in an isolated sandbox and never pushes them for you." },
  { q: "Is the Autonomous Developer available?", a: "Not yet for everyone. It's a private preview used by the site's administrators while it matures." },
];
