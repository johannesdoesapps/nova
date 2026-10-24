/**
 * Public-site content: feature pages, guides, pricing and FAQ. Everything here
 * describes what Orbis does today; anything not generally available carries a
 * status, and limits are stated next to the feature they apply to.
 */
import { PLANS } from "@/lib/plans";

export type Status = "available" | "beta" | "preview" | "planned";
export const STATUS_LABEL: Record<Status, string> = {
  available: "Available",
  beta: "Beta",
  preview: "Private preview",
  planned: "Coming soon",
};

/** The three ways Orbis is used, and how the homepage groups its features. */
export type PillarId = "think" | "build" | "execute";

export interface Feature {
  slug: string;
  name: string;
  pillar: PillarId;
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
  /** A real screenshot of the feature (public/product), with what it shows. */
  image?: { src: string; alt: string; width: number; height: number };
}

export const FEATURES: Feature[] = [
  {
    slug: "ai-assistant",
    name: "AI Chat",
    pillar: "think",
    title: "AI Chat with Claude and GPT models in one workspace",
    description:
      "Chat with Claude and GPT models in one place. Auto picks a model for each message and says why, or choose one yourself. Searchable history, file uploads and code you can run.",
    status: "available",
    tagline: "One chat for several leading AI models — with the model, and the reason it was chosen, shown on every reply.",
    audience: "Anyone who writes, researches or learns with AI and wants more than one model without juggling subscriptions.",
    appPath: "/chat",
    appLabel: "Open Chat",
    highlights: [
      { title: "Auto or your choice", text: "Auto chooses a model for each message — Quick, Deep, Research or Coding — and shows the reason under the reply. Or pick a Claude or GPT model yourself." },
      { title: "History you can manage", text: "Conversations are saved to your account and searchable. Rename, archive, delete or move them into a project. Edit a question you sent to get a new answer." },
      { title: "Files and code", text: "Attach documents by button, drag-and-drop or paste. Code blocks in replies have a Run button that runs Python, JavaScript, TypeScript or Bash in an isolated computer." },
      { title: "Replies your way", text: "Choose short, normal or detailed replies, and a precise, balanced or creative style. Copy, regenerate or stop any reply." },
      { title: "Connected apps", text: "With Connectors, chat can look things up in apps you connect and cite them. Anything that changes an app waits for you to confirm it." },
      { title: "Visible usage", text: "Every reply names the model that wrote it, and your plan's usage and reset times are always one click away." },
    ],
    steps: ["Create a free account.", "Ask anything — leave the model on Auto or choose one.", "Read why the model was chosen, then continue, edit your question, regenerate or try another model."],
    limits: [
      "Live web search isn't enabled on tryorbis.app yet, so answers don't cite live web sources. Research mode says so when it applies.",
      "Usage is limited per plan (see Pricing). Larger models use more of your allowance than fast ones.",
    ],
    guide: "getting-started",
    image: { src: "/product/chat.webp", alt: "Orbis Chat answering a question about row-level security versus permission checks in application code; the reply is labelled Claude Haiku 5.5 with an Auto badge.", width: 2400, height: 1500 },
  },
  {
    slug: "multi-model",
    name: "Council & Arena",
    pillar: "think",
    title: "Compare AI models side by side — Orbis Council and Orbis Arena",
    description:
      "Ask several AI models the same question. Council combines their answers into one synthesis that lists where they agree and disagree; Arena lets you compare them blind and pick a winner.",
    status: "available",
    tagline: "Don't rely on one model's answer — see where several agree, and where they don't.",
    audience: "Anyone making a decision from AI output who wants a cross-check before relying on it.",
    appPath: "/council",
    appLabel: "Open Council",
    highlights: [
      { title: "Council", text: "Each model answers independently; in Deep mode they review each other's anonymised answers; a chair model writes a synthesis listing agreements, disagreements and what still needs checking." },
      { title: "Arena", text: "Blind mode hides model names until you reveal them. Rate answers, pick a winner, or ask a model to improve its answer." },
      { title: "Every step visible", text: "Model, time, tokens and estimated cost are shown for each step. A failed model doesn't stop the others." },
    ],
    steps: ["Open Council or Arena.", "Choose two or more models and ask your question.", "Read the synthesis or compare the answers, then save the session."],
    limits: [
      "Models comparing answers is a cross-check, not independent verification: they can share the same mistake.",
      "Each model's answer counts against your usage, so a Council costs more than a single reply.",
    ],
    guide: "council-and-arena",
    image: { src: "/product/council.webp", alt: "Orbis Council: three models answered a question about monoliths and microservices, and a chair model's synthesis recommends a modular monolith, with its time, tokens and cost shown.", width: 2400, height: 1500 },
  },
  {
    slug: "ai-coding-assistant",
    name: "Code",
    pillar: "build",
    title: "AI coding agent that builds websites and runs your tests",
    description:
      "A code workspace and a coding agent that builds websites from a prompt, checks them in a real browser, runs your tests and fixes failures, with changes you can revert.",
    status: "beta",
    tagline: "Describe a website or a change. The agent builds it, runs it, checks it in a real browser and runs the tests — and shows you every step and every diff.",
    audience: "Developers, students and makers who want AI help that works on real files and checks its work by running it.",
    appPath: "/code",
    appLabel: "Open Code",
    highlights: [
      { title: "A real workspace", text: "Create a project (blank, Python, Node.js or website) or import one from GitHub. Edit files, run commands in a terminal and see your app in a live preview." },
      { title: "A coding agent", text: "It reads the code, proposes a plan for you to approve, edits files, runs tests and builds, reads the errors and tries again — then summarises what it did and what's left." },
      {
        title: "Websites from a prompt",
        text: "Describe a site and press Build website. The agent writes it, starts it on the project's computer and opens it in a real browser at desktop, tablet and phone sizes — errors, broken links, sideways scrolling and the phone menu are checked — then fixes what it finds. Ask for changes and watch the preview update.",
      },
      { title: "You stay in control", text: "Tests, builds and installs run on their own; other commands ask you first; a few (like deleting everything, deploying or git push) never run. You can review each set of edits before it's saved, and Stop at any time." },
      { title: "Every change reviewable", text: "The Changes panel shows each run's edits as diffs. Revert a whole run or one file. Push the project to a new GitHub branch when you're ready." },
      { title: "Isolated computer", text: "Commands run on the project's own short-lived computer with internet limited to npm and PyPI, and none of Orbis's keys inside." },
      { title: "Quick edits too", text: "Ask for one change and accept or reject the proposed diff, without starting an agent run." },
    ],
    steps: [
      "Open Code and describe a website under Build a website, or create or import a project.",
      "In the Agent panel, describe the change (and approve the plan, if you chose Ask first).",
      "Watch it work, look at the live preview, then ask for changes, review or revert.",
    ],
    limits: [
      "Beta. The agent works while the page is open; it pauses if you close it, and you can continue later.",
      "Each agent step counts like one chat message; commands use your plan's workspace minutes (Free: 20 a month).",
      "The computer can't reach the internet beyond npm and PyPI, and programs that wait for keyboard input don't work. The browser check can't load web fonts or files from other sites.",
      "Forms on generated websites don't send anywhere until you connect a backend; the agent says so on the page.",
      "Push to GitHub needs Orbis's GitHub app with write access, which isn't set up on tryorbis.app yet.",
    ],
    guide: "code-agent",
    image: {
      src: "/product/code-website.webp",
      alt: "Orbis Code after building a website from one prompt: the agent's report with its browser check, development server and files changed, beside the live preview of the page it made.",
      width: 2400,
      height: 1458,
    },
  },
  {
    slug: "autonomous-developer",
    name: "Autonomous Developer",
    pillar: "build",
    title: "Autonomous Developer — AI agents that plan, code and verify",
    description:
      "Orbis's AI Workforce plans a change to a GitHub repository, writes it in an isolated sandbox, runs the project's real type checks, lint, tests and build, and reports what passed. Private preview.",
    status: "preview",
    tagline: "A team of agents that plan, write and verify a change — and only call it done when the checks pass.",
    audience: "Orbis's own team today. It isn't open for sign-up yet.",
    appPath: "/workforce",
    appLabel: "Open Workforce (admins)",
    highlights: [
      { title: "A team of agents", text: "One maps the code, one plans, one writes the change, QA runs the checks, and a reviewer and a security agent review it." },
      { title: "Isolated sandbox", text: "Each task runs in its own sandbox with network access cut off after dependencies install." },
      { title: "Human approval", text: "You approve the plan before any code is written; high-risk plans always need a person." },
      { title: "Verified, not just generated", text: "A task is only marked verified when the project's real checks pass. Budgets cap spending per task." },
    ],
    steps: ["Register a GitHub repository.", "Describe the change and approve the plan.", "Review the verified diff and report; nothing is pushed for you."],
    limits: ["Private preview: available to the site's administrators only.", "Supports npm projects on GitHub. It doesn't open pull requests or push code."],
    guide: "autonomous-developer",
  },
  {
    slug: "ai-agents",
    name: "Agents",
    pillar: "execute",
    title: "AI agents — built-in specialists and your own custom agents",
    description:
      "Use Orbis's built-in Research, Coding, Writing, Data Analyst, Creative and General agents, or create your own with custom instructions, a default model and starter prompts.",
    status: "available",
    tagline: "Specialised assistants with their own instructions and history — use ours or build your own.",
    audience: "People who repeat the same kind of task and want an assistant that already knows how they like it done.",
    appPath: "/agents",
    appLabel: "Browse agents",
    highlights: [
      { title: "Six built-in agents", text: "Research, Coding, Writing, Data Analyst, Creative and General — each with its own instructions and starter prompts." },
      { title: "Your own agents", text: "Write instructions (20–8,000 characters), pick an icon, colour, default model and up to four starter prompts." },
      { title: "Customise a copy", text: "Start from any built-in agent and change what you need; the original stays untouched." },
      { title: "Separate history", text: "Each agent keeps its own conversations next to your general chats." },
    ],
    steps: ["Open Agents.", "Pick a built-in agent, or choose Create agent and describe how it should work.", "Chat with it; edit its instructions whenever you want."],
    limits: ["Agents use the same models and usage limits as Chat.", "Chat agents write, explain and plan; they don't take actions in other apps on their own."],
    guide: "custom-agents",
  },
  {
    slug: "mission-control",
    name: "Mission Control",
    pillar: "execute",
    title: "Mission Control — turn goals into plans and AI-drafted tasks",
    description:
      "Turn a goal into an editable plan of milestones and tasks, and let AI draft the tasks it can help with. You decide what's saved and what's done.",
    status: "available",
    tagline: "From a goal to a plan you can work through — with AI drafting the parts it can.",
    audience: "Founders, students and teams planning projects who want structure without a heavy project-management tool.",
    appPath: "/missions",
    appLabel: "Open Mission Control",
    highlights: [
      { title: "Plan from a goal", text: "Describe what you want to achieve; Orbis proposes milestones and tasks with priorities, which you edit before saving." },
      { title: "AI drafts, you decide", text: "Tasks marked “AI can draft this” can be drafted by any model. Drafts are saved to the mission and every attempt is logged." },
      { title: "You mark progress", text: "The AI never marks tasks complete. Progress is yours to track." },
    ],
    steps: ["Open Mission Control and describe your goal.", "Edit the proposed plan and press Create.", "Ask AI to draft tasks, edit the drafts, and tick tasks off yourself."],
    limits: ["Mission Control plans and drafts. It doesn't run tasks on its own or act outside Orbis."],
    guide: "mission-control",
    image: { src: "/product/missions.webp", alt: "Mission Control: a proposed six-week plan for launching a newsletter, with weekly milestones and prioritised tasks, some marked “AI can draft”.", width: 2400, height: 1500 },
  },
  {
    slug: "connectors",
    name: "Connectors",
    pillar: "execute",
    title: "Connectors — use your apps' content in Orbis, with permission",
    description:
      "Connect apps so chat can search and cite them — Wikipedia today; Google, Microsoft, Slack, Notion, GitHub and more awaiting setup. Any change to an app waits for your OK.",
    status: "beta",
    tagline: "Bring your apps' content into your answers — read-only by default, and nothing changes without your OK.",
    audience: "People whose work lives across documents, email, chat and code, and who want answers that draw on it.",
    appPath: "/connectors",
    appLabel: "Open Connectors",
    highlights: [
      { title: "Search what you connect", text: "Chat decides when a question needs one of your apps, searches it, and cites what it used. You can set each app to Auto, only when mentioned, or off." },
      { title: "Your permission, your scopes", text: "Apps connect with their own sign-in (OAuth). Orbis asks for the narrowest access each feature needs, and writing is a separate switch that starts off." },
      { title: "Confirm every change", text: "When the AI suggests drafting an email, creating an event or posting a message, you see exactly what it will do and confirm it first." },
      { title: "Tokens locked away", text: "Access tokens are encrypted on the server and never sent to your browser. Disconnect any app at any time." },
    ],
    steps: ["Open Connectors.", "Turn on an available app and sign in to it.", "Ask in chat — Orbis searches the app when it helps and shows its sources."],
    limits: [
      "On tryorbis.app, Wikipedia is ready to use. The other apps are built but each needs Orbis's own app registration with that provider first; until then they're marked “Not set up yet”.",
    ],
    guide: "connectors",
  },
  {
    slug: "security-agents",
    name: "Security Team",
    pillar: "execute",
    title: "AI security agents for website, log and code checks",
    description:
      "Three security agents — Sentinel (website checks), Threat Hunter (log analysis) and Code Guardian (code and dependency audits) — that use real scanners and explain what they find.",
    status: "beta",
    tagline: "Real scanners find the issues; AI explains them and proposes fixes you can review.",
    audience: "Developers and site owners who want a quick, explained security check of their own site, logs or code.",
    appPath: "/agents/security",
    appLabel: "Open the Security Team",
    highlights: [
      { title: "Orbis Sentinel", text: "Checks a website you own for HTTPS, security headers, cookies, CORS and exposed files — only after you prove ownership." },
      { title: "Orbis Threat Hunter", text: "Analyses web and SSH logs you upload for suspicious patterns." },
      { title: "Orbis Code Guardian", text: "Scans code for leaked secrets and risky patterns, and checks dependencies against the OSV vulnerability database." },
      { title: "Findings with evidence", text: "Every finding has severity, confidence, evidence and a fix. AI reviews only count when the quoted code really exists in your files." },
    ],
    steps: ["Open Security Team.", "Verify a site you own, upload logs, or point Code Guardian at code.", "Review findings, then export a report."],
    limits: ["Website scans require proof that you own the site and never reach private network addresses.", "It's a point-in-time check, not continuous monitoring, and it never applies fixes for you."],
    guide: "security-team",
  },
];

export interface Pillar {
  id: PillarId;
  label: string;
  title: string;
  text: string;
  href: string;
  cta: string;
}

export const PILLARS: Pillar[] = [
  {
    id: "think",
    label: "Think",
    title: "Think through complex problems.",
    text: "Explore ideas, analyse documents and compare AI perspectives — with the model behind every answer named, so you know what you're relying on.",
    href: "/features/ai-assistant",
    cta: "Explore Chat",
  },
  {
    id: "build",
    label: "Build",
    title: "Build real things with AI.",
    text: "Understand code, implement features and fix bugs with an agent that runs your tests on an isolated computer — and shows every change as a diff you can revert.",
    href: "/features/ai-coding-assistant",
    cta: "Explore Code",
  },
  {
    id: "execute",
    label: "Execute",
    title: "Turn plans into progress.",
    text: "Break goals into tasks, use specialised agents and bring in your connected apps — with the AI drafting and you deciding what's done.",
    href: "/features/ai-agents",
    cta: "Explore Agents",
  },
];

export const featuresIn = (pillar: PillarId) => FEATURES.filter((f) => f.pillar === pillar);

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
    title: "Getting started with Orbis",
    description: "Create an account, ask your first question, choose a model and find your way around Orbis's workspace.",
    feature: "ai-assistant",
    sections: [
      { heading: "Create your account", body: ["Go to Sign up and enter your email address and a password of at least 8 characters. Once your account is ready you're taken to the chat.", "Every new account starts on the Free plan."] },
      { heading: "Ask your first question", body: ["Type in the composer at the bottom of the chat and press Enter. Shift+Enter adds a new line.", "Leave the model on Auto and Orbis picks one for you; the reason appears under the reply."] },
      { heading: "Choose a model yourself", body: ["Open the model menu in the composer to pick a specific Claude or GPT model, or a Smart Router mode: Quick for short questions, Deep for harder reasoning, Research for sourced answers, Coding for programming."] },
      { heading: "Find things quickly", body: ["Press Ctrl+K (⌘K on Mac) to open the command palette: jump to a past conversation, switch model, or go to Agents, Mission Control and the rest of Orbis.", "The sidebar lists your conversations by date. Use the menu next to a conversation to rename, archive or delete it. Hover over a question you sent to edit it."] },
      { heading: "Know your limits", body: ["Each plan has a 5-hour and a weekly allowance. A message to a low-cost model uses 1 unit; larger models use more. When you're close to a limit, Auto prefers low-cost models and says so."] },
    ],
  },
  {
    slug: "choosing-a-model",
    short: "Choosing a model",
    title: "Choosing a model: Auto and the Smart Router modes",
    description: "How Orbis's Smart Router chooses a model, what Quick, Deep, Research and Coding modes do, and when to pick a model yourself.",
    feature: "ai-assistant",
    sections: [
      { heading: "What Auto does", body: ["Auto looks at your message and the models available on this site, then chooses one and shows why under the reply. It never picks a model that isn't configured."] },
      { heading: "The four modes", body: ["Quick favours fast, low-cost models for short questions.", "Deep favours models that reason more carefully, for analysis and harder problems.", "Research looks for sourced answers when web search is available, and says so when it isn't.", "Coding narrows the choice to models suited to programming."] },
      { heading: "When to choose a model yourself", body: ["Pick a specific model when you want consistent behaviour across a long conversation, or when you want to compare how two models handle the same prompt — Orbis Arena makes that easier."] },
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
    slug: "code-agent",
    short: "Coding agent",
    title: "Using the coding agent in Code",
    description: "Ask Orbis's coding agent to change a project: approve its plan, let it run tests, answer its questions, and review or revert what it changed.",
    feature: "ai-coding-assistant",
    sections: [
      { heading: "Start a project", body: ["Open Code and create a project from a template (blank, Python, Node.js or website), or import one of your GitHub repositories.", "Your files are saved to your account. The project's computer — where commands and the preview run — starts only when you, or the agent, need it."] },
      { heading: "Describe the change", body: ["In the Agent panel, say what you want, as you would to a colleague: “Add tests for the cart and make them pass”, or “Fix the crash when the list is empty”.", "Choose whether to see the plan first (on by default), whether to review each set of edits before it's saved, and which commands may run without asking."] },
      { heading: "Approve, answer, watch", body: ["The agent reads the relevant files and proposes a plan. Nothing changes until you approve it.", "It then edits files and runs tests or builds. Commands outside the safe list (tests, builds, installs and read-only commands) wait for your OK; deleting everything, deploying and git push never run.", "If it needs the computer, it asks you to start it. Starting it uses workspace minutes from your plan."] },
      { heading: "Review and revert", body: ["When it finishes you get a summary of what it changed, what it ran and what's left. Open Changes to see every edited file as a diff.", "Revert a whole run or a single file. If you changed a file since, Orbis warns you before overwriting it."] },
      { heading: "What it costs", body: ["Each step the agent takes counts like one chat message on your plan; the run shows its step count. Commands use workspace minutes, counted in 10-minute blocks."] },
    ],
  },
  {
    slug: "connectors",
    short: "Connecting apps",
    title: "Connecting apps to Orbis",
    description: "How Connectors work: what Orbis can read once you connect an app, how it asks before changing anything, and how to disconnect.",
    feature: "connectors",
    sections: [
      { heading: "Connect an app", body: ["Open Connectors, choose an app and turn it on. Apps that need a sign-in send you to that app's own sign-in page; Orbis never sees your password.", "On tryorbis.app, Wikipedia is ready to use. Other apps show “Not set up yet” until Orbis has registered with that provider."] },
      { heading: "Ask in chat", body: ["Chat searches a connected app when your question needs it, and cites what it used. Set an app to “Only when I mention it” or “Off” if you prefer."] },
      { heading: "Changes need your OK", body: ["Writing to an app is a separate switch that starts off. When it's on and the AI suggests an action — a draft email, a calendar event, a message — you see exactly what it will do and confirm it first."] },
      { heading: "Disconnect", body: ["Disconnect an app on its Connectors page at any time. Orbis deletes its stored access and, where the app supports it, revokes it too."] },
    ],
  },
  {
    slug: "council-and-arena",
    short: "Council & Arena",
    title: "Comparing models with Orbis Council and Orbis Arena",
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
      { heading: "Describe the goal", body: ["Open Mission Control and describe what you want to achieve and by when. Orbis proposes milestones and tasks with priorities."] },
      { heading: "Edit before saving", body: ["Nothing is saved until you press Create. Rename, reorder, add or remove anything first."] },
      { heading: "Let AI draft", body: ["Tasks marked “AI can draft this” can be drafted by any model — an outline, an email, a checklist. Edit the draft and save it to the mission's notes."] },
      { heading: "You mark progress", body: ["Only you can mark a task complete. The AI is told it can't take actions outside Orbis."] },
    ],
  },
  {
    slug: "security-team",
    short: "Security checks",
    title: "Running a security check with the Security Team",
    description: "How to verify your website, analyse logs and audit code with Orbis Sentinel, Threat Hunter and Code Guardian.",
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
    description: "The steps Orbis's AI Workforce takes to plan, build and verify a code change, and the safeguards around it. Private preview.",
    feature: "autonomous-developer",
    sections: [
      { heading: "Status", body: ["The Autonomous Developer is a private preview available to the site's administrators. It isn't open for general sign-up yet."] },
      { heading: "From request to verified change", body: ["An Archaeologist agent maps the relevant code, an Architect writes a plan, and you approve it. A Builder then writes the change in an isolated sandbox and QA runs the project's own type checks, lint, tests and build. A Reviewer and a Security agent review the result.", "If a check fails, a Self-Heal agent tries a bounded number of repairs."] },
      { heading: "Safeguards", body: ["Every task has a spending and token budget. The sandbox loses network access after dependencies install. High-risk plans always need a person. A task only counts as verified when the real checks pass, and nothing is pushed to your repository."] },
    ],
  },
];

export const guideBySlug = (slug: string) => GUIDES.find((g) => g.slug === slug);

const codeLine = (id: "free" | "pro" | "max") =>
  `Code: ${PLANS[id].codeProjects} projects, ${PLANS[id].workspaceMinutesPerPeriod.toLocaleString("en-US")} computer minutes a month`;

export const PRICING = {
  free: { name: PLANS.free.label, price: PLANS.free.priceUsd, window: PLANS.free.windowUnits, weekly: PLANS.free.weeklyUnits, models: "Fast, low-cost Claude and GPT models", code: codeLine("free") },
  pro: { name: PLANS.pro.label, price: PLANS.pro.priceUsd, window: PLANS.pro.windowUnits, weekly: PLANS.pro.weeklyUnits, models: "Adds Claude Sonnet and GPT Terra", code: codeLine("pro") },
  max: { name: PLANS.max.label, price: PLANS.max.priceUsd, window: PLANS.max.windowUnits, weekly: PLANS.max.weeklyUnits, models: "Adds Claude Opus and GPT Sol", code: codeLine("max") },
};

export const FAQ: { q: string; a: string }[] = [
  { q: "What is Orbis?", a: "Orbis is an AI coding agent in a web workspace. It builds and fixes websites and applications on each project's own short-lived computer, runs your tests, checks websites in a real browser and reports what it changed and what it couldn't verify. The same account has chat with several leading models, side-by-side comparison of their answers, templates and project plans." },
  { q: "Which AI models does Orbis use?", a: "On tryorbis.app: Claude models from Anthropic and GPT models from OpenAI. Orbis can also use Gemini, Grok and DeepSeek when they're switched on. Every reply names the model that wrote it." },
  { q: "Is Orbis free?", a: `Yes. The Free plan includes ${PLANS.free.windowUnits} usage units per 5-hour window and ${PLANS.free.weeklyUnits} per week, with fast models. A typical message to a fast model uses 1 unit; larger models, longer messages and bigger files use more. Pro ($${PLANS.pro.priceUsd}/month) and Max ($${PLANS.max.priceUsd}/month) add usage and larger models. No plan is unlimited.` },
  { q: "Do I need a credit card to sign up?", a: "No. You sign up with an email address and password (or Google, where enabled) and start on the Free plan." },
  { q: "What happens to my conversations and code?", a: "They're saved to your account so you can come back to them, and only you can read them. Your messages are sent to the provider of the model that answers, which each reply names. See Security & data for details." },
  { q: "Can Orbis's agents take actions for me?", a: "Only within limits you can see. The coding agent edits your Orbis project and runs commands on that project's isolated computer — tests and builds on their own, anything else after you approve, and some never. Changes to connected apps (like drafting an email) always wait for your confirmation. Chat agents and Mission Control write, explain and plan; they don't act on their own." },
  { q: "Does the coding agent really run my tests?", a: "Yes — on the project's own short-lived computer. You see each command, its exit code and its output. If a command couldn't run, the agent says so instead of claiming it passed." },
  {
    q: "Can I build a whole website on the Free plan?",
    a: `You can start one. A full site usually takes 10 to 20 agent steps, each charged like a message of its size (steps carry the project's files, so often more than one typical message), plus a few minutes of computer time. Free allows ${PLANS.free.windowUnits} units per 5 hours and ${PLANS.free.workspaceMinutesPerPeriod} computer minutes a month, so a larger site may have to continue after your limit resets, or on Pro.`,
  },
  { q: "Does the coding agent deploy or publish anything?", a: "No. Pushing to GitHub, publishing packages and deploying are blocked for the agent, even if asked. You can push a project's changes to GitHub yourself from Changes, or download the project as a .zip." },
  { q: "Are the screenshots and the run on this page real?", a: "Yes. They're captures of real sessions on tryorbis.app with a test account, and each caption says when it was taken. The steps of the run are copied from its activity log. Nothing on the page is a simulation." },
  { q: "What happens when I reach my limit?", a: "Orbis tells you which limit you reached and when it resets. The 5-hour window and weekly allowance reset on their own; nothing is charged automatically unless you turn on automatic top-ups yourself, and no plan is upgraded without you." },
]
