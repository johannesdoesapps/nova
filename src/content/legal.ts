/**
 * Privacy Policy and Terms of Service. Written from how Orbis actually works
 * (what it stores, who receives what); keep them in step with the product.
 * Change `updated` whenever the meaning changes.
 *
 * Text uses a tiny markup: [label](href) for links. A block is a paragraph
 * (string) or a bulleted list ({ list: [...] }).
 */

export const LEGAL = {
  /** The registered legal name of the business that runs Orbis, once it exists. Shown where set. */
  operatorName: null as string | null,
  /** Its postal (geographic) address — required by UK e-commerce rules once known. */
  address: null as string | null,
  country: "United Kingdom",
  email: "support@tryorbis.app",
  minimumAge: 13,
  updated: "20 October 2026",
};

/** "the operator of Orbis", or the registered name once it's set. */
export const OPERATOR = LEGAL.operatorName ?? "the operator of Orbis";

export type Block = string | { list: string[] };
export interface LegalSection {
  id: string;
  title: string;
  blocks: Block[];
}

const mail = `[${LEGAL.email}](mailto:${LEGAL.email})`;

export const PRIVACY: LegalSection[] = [
  {
    id: "who",
    title: "Who we are",
    blocks: [
      `Orbis (tryorbis.app) is an AI workspace run from the ${LEGAL.country} by ${OPERATOR}${LEGAL.address ? `, ${LEGAL.address}` : ""} (“Orbis”, “we”, “us”). We decide how and why your personal data is used, which makes us the “controller” under the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018.`,
      `Questions or requests about your data: ${mail}.`,
    ],
  },
  {
    id: "summary",
    title: "The short version",
    blocks: [
      {
        list: [
          "We collect what's needed to run Orbis: your account, what you put into it, and records of how much you use.",
          "To answer you, your messages are sent to the AI provider of the model that replies — today Anthropic (Claude) and OpenAI (GPT). Every reply names its model.",
          "We don't sell your data, show ads, or use your content to train AI models.",
          "Only strictly necessary cookies are used. There are no analytics or advertising cookies.",
          "You can delete conversations and projects at any time, disconnect apps, and ask us to delete your account.",
        ],
      },
    ],
  },
  {
    id: "collect",
    title: "What we collect",
    blocks: [
      "**Your account.** Your email address, the name you give (optional) and your password, which our sign-in provider stores only as a secure hash. If you sign in with Google or GitHub, we receive your name, email address and account ID from them.",
      "**What you put into Orbis.**",
      {
        list: [
          "Your messages and the AI's replies, conversation titles and the sources cited. For files you attach, we keep only the file names: the contents are sent to the AI model to answer you but aren't stored by Orbis.",
          "Agents, missions, Council and Arena sessions, projects and notes you create.",
          "Code projects and their files. For each coding agent run: your request, an activity log of what it read, ran and changed (including command output), and each changed file's content before and after the run, so you can review and revert it.",
          "Security Team targets, scan results and findings, including short excerpts of evidence.",
          "Your settings, such as reply length and style.",
        ],
      },
      "**Connected apps.** When you connect an app, we store an account label (such as the connected account's email address), the permissions you granted, the access tokens — encrypted on our server and never sent to your browser — and when the connection was made, checked and last used. When you confirm an action in an app (such as creating a draft email), we log the app, the action, whether it worked and a short summary, but not the message or document content. What Orbis reads from your apps is used to answer you and is saved only as part of that answer and its cited sources in your conversation.",
      "**Usage records.** For each AI request we record the model, number of tokens, estimated cost, time taken, what it was for, and the first part of the prompt and reply (up to 4,000 and 8,000 characters). These records enforce plan limits and budgets, and help us prevent abuse and fix problems. For code you run from a chat reply, we record only the language and exit code, not the code or its output. For workspace computer time, we record the minutes used.",
      "**Payments.** When paid plans are on sale, payments are handled by Stripe. We receive your Stripe customer ID, plan, subscription status and billing period, never your card number.",
      "**Technical data.** Our hosting and sign-in providers process your IP address and browser details in their logs to deliver the service and keep it secure. If you use Orbis without an account, your IP address is used briefly in memory to apply rate limits; it isn't stored in our database.",
      "**On your device.** Without an account, your conversations are kept only in your browser's local storage; Orbis's servers don't store guest chat history. Preferences (theme, sidebar, last model, saved prompts and the thumbs-up/down you give replies) are also kept in your browser only.",
    ],
  },
  {
    id: "use",
    title: "How we use it, and why we're allowed to",
    blocks: [
      {
        list: [
          "**To provide Orbis** — your account, storing your work, sending your requests to AI models, running code, and connecting apps you choose. Legal basis: performing our contract with you.",
          "**To apply plan limits and take payment** — usage records, subscriptions and billing records. Legal basis: contract, and legal obligation for tax and accounting records.",
          "**To keep Orbis secure and prevent abuse** — rate limits, usage caps, logs and investigating misuse. Legal basis: our legitimate interest in a safe, working service.",
          "**To support you and send service messages** — such as confirming your email or resetting your password. Legal basis: contract.",
          "**To understand overall usage** — for example, which models are used and what they cost, using aggregated usage records. Legal basis: legitimate interests.",
        ],
      },
      "We don't use your conversations, files or code to train AI models, we don't sell personal data, and we don't use it for advertising.",
    ],
  },
  {
    id: "recipients",
    title: "Who receives your data",
    blocks: [
      "We use these service providers to run Orbis. They process data on our behalf, under their data processing terms:",
      {
        list: [
          "**Supabase** — database and sign-in. Data is stored in the United States (AWS US East).",
          "**Vercel** — website hosting, server functions, and the isolated computers that run code. United States.",
          "**Anthropic** (Claude models) and **OpenAI** (GPT models) — receive your message, the earlier messages of that conversation, the contents of files you attach, and, for coding agent runs, the parts of your project the agent reads. Under their API terms, data sent through their APIs isn't used to train their models by default; they may keep it for a limited period to monitor abuse.",
          "**Stripe** — payments, once paid plans are on sale.",
        ],
      },
      "Only Anthropic and OpenAI models are enabled on tryorbis.app today. Orbis can also use Google (Gemini), xAI (Grok), DeepSeek and a web search provider (Tavily or Brave); we'll add any of them to this list before they receive your data.",
      "**Apps you connect** (such as Google Drive, Gmail, Slack, Notion, GitHub or Wikipedia) receive the searches Orbis makes for you and the actions you confirm. Their own privacy policies apply to what they do with it.",
      "**Package registries** (npm and PyPI) see the download requests your project's computer makes when it installs packages.",
      "We may also disclose data if the law requires it, to protect people's safety, or as part of a sale or reorganisation of Orbis, in which case this policy continues to apply to your data.",
    ],
  },
  {
    id: "transfers",
    title: "International transfers",
    blocks: [
      "Our main providers store and process data in the United States. Where data leaves the UK, we rely on the safeguards the law provides: the UK–US data bridge for certified companies, or the UK International Data Transfer Addendum or Agreement included in our providers' data processing terms.",
    ],
  },
  {
    id: "retention",
    title: "How long we keep it",
    blocks: [
      {
        list: [
          "**Your account and your content** — while your account exists. When you delete a conversation, project or agent, it's removed from our database straight away; copies may remain in our providers' backups for a limited time before they're overwritten.",
          "**Usage records** — while your account exists, because they underpin your limits and billing history.",
          "**Billing records** — as long as tax law requires (usually six years in the UK).",
          "**Connected-app tokens** — until you disconnect the app or delete your account.",
          "**When you delete your account** — we delete it and the content linked to it within 30 days of your request, except billing records we must keep by law.",
        ],
      },
    ],
  },
  {
    id: "rights",
    title: "Your rights",
    blocks: [
      "Under UK data protection law you can ask us to give you a copy of your data, correct it, delete it, restrict or object to how we use it, or send it to you in a portable format. You can withdraw any consent you've given at any time.",
      `To make a request, email ${mail} from the address on your account. We'll reply within one month. Deleting your account isn't self-service yet, so this is also how you ask for that.`,
      "If you're unhappy with how we handle your data, please tell us first. You can also complain to the Information Commissioner's Office: [ico.org.uk](https://ico.org.uk/make-a-complaint/) or 0303 123 1113.",
    ],
  },
  {
    id: "cookies",
    title: "Cookies and storage on your device",
    blocks: [
      "Orbis uses only cookies that are strictly necessary for it to work, so it doesn't ask for cookie consent:",
      {
        list: [
          "**Sign-in cookies** (from Supabase, names starting with “sb-”) keep you signed in.",
          "**A temporary connection cookie** (orbis_connect) protects the sign-in to an app you're connecting. It lasts 10 minutes.",
        ],
      },
      "Your browser's local storage holds your preferences and, without an account, your conversations. You can clear them in your browser at any time. There are no analytics or advertising cookies. If we ever add analytics, we'll update this policy first and ask for your consent where the law requires it.",
    ],
  },
  {
    id: "children",
    title: "Children",
    blocks: [
      `Orbis is for people aged ${LEGAL.minimumAge} and over. If you're under 18, you need a parent's or guardian's permission to use it. If we learn that someone under ${LEGAL.minimumAge} has an account, we'll delete it. Parents can contact us at ${mail}.`,
    ],
  },
  {
    id: "security",
    title: "How we protect it",
    blocks: [
      "Data is sent over HTTPS. Database row-level security means signed-in users can read only their own data. Connected-app tokens are encrypted with a key only our server holds. Code runs on isolated, short-lived computers that hold none of Orbis's own keys. No system is perfectly secure; if a breach affects your personal data, we'll tell you and the ICO as the law requires. More detail is on [Security & data](/security).",
    ],
  },
  {
    id: "changes",
    title: "Changes to this policy",
    blocks: [
      "We'll post any new version here with a new date. If a change significantly affects how we use your data, we'll tell you in Orbis or by email before it takes effect.",
    ],
  },
  {
    id: "contact",
    title: "Contact",
    blocks: [`${mail}`],
  },
];

export const TERMS: LegalSection[] = [
  {
    id: "about",
    title: "About these terms",
    blocks: [
      `These terms are an agreement between you and ${OPERATOR}${LEGAL.address ? `, ${LEGAL.address}` : ""} (“Orbis”, “we”, “us”), based in the ${LEGAL.country}. By creating an account or using Orbis at tryorbis.app, you agree to them. If you use Orbis for an organisation, you confirm that you're allowed to accept these terms for it.`,
      "How we handle personal data is explained in our [Privacy Policy](/privacy).",
    ],
  },
  {
    id: "eligibility",
    title: "Who can use Orbis",
    blocks: [
      {
        list: [
          `You must be at least ${LEGAL.minimumAge} years old. If you're under 18, you need permission from a parent or guardian, who agrees to these terms on your behalf.`,
          "Give accurate details when you sign up and keep your password safe. You're responsible for what happens in your account. One account is for one person; don't share it.",
        ],
      },
    ],
  },
  {
    id: "service",
    title: "The service",
    blocks: [
      "Orbis gives you access to AI models from several providers, specialised and custom agents, a code workspace with a coding agent, model comparison, planning tools and app connectors, as described on this site.",
      "Features marked Beta or Private preview are still being developed: they may change, have limits or be withdrawn. We work to keep Orbis available and reliable, but we can't promise it will always be available or error-free, and we may change or remove features. If we remove something significant from a paid plan, we'll tell you in advance.",
    ],
  },
  {
    id: "ai",
    title: "AI output",
    blocks: [
      {
        list: [
          "AI models can be wrong, incomplete or out of date, and can produce content that's offensive or that someone else holds rights in. Check output before you rely on it, especially for anything important.",
          "Output isn't professional advice. Don't use it as a substitute for a qualified lawyer, doctor, financial adviser or other professional.",
          "Other users may receive similar output to yours.",
          "Each reply names the model that wrote it. The providers' own usage rules also apply to what you ask their models to do: the [Anthropic Usage Policy](https://www.anthropic.com/legal/aup) and [OpenAI Usage Policies](https://openai.com/policies/usage-policies/).",
        ],
      },
    ],
  },
  {
    id: "content",
    title: "Your content",
    blocks: [
      "You keep ownership of what you put into Orbis — your messages, files, code and other content. As between you and us, you also own the output Orbis produces for you, to the extent the law allows.",
      "You give us permission to store, process and transmit your content — including sending it to AI providers and to apps you connect — only as needed to run Orbis for you, keep it secure and comply with the law. We don't use your content to train AI models.",
      "You confirm that you have the right to submit the content you put into Orbis, including files, code and content from apps you connect.",
    ],
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    blocks: [
      "Don't use Orbis to:",
      {
        list: [
          "break the law, or infringe anyone's intellectual property, privacy or other rights;",
          "create or share sexual content involving minors, or content that threatens, harasses or promotes violence against people;",
          "create malware, attack or gain unauthorised access to systems, or scan or test systems you don't own or have permission to test;",
          "use the code computers for cryptocurrency mining, spam, denial-of-service, proxying traffic, or to get around their network limits;",
          "get around usage limits or plan restrictions — for example with several accounts — or resell or share access to Orbis;",
          "copy, scrape or reverse-engineer Orbis, except where the law allows it, or use it to build a competing service;",
          "pass off AI output as written by a person where that would mislead someone.",
        ],
      },
      "If you break these rules, we may remove content, limit features, or suspend or close your account (see below).",
    ],
  },
  {
    id: "code",
    title: "Code, agents and connected apps",
    blocks: [
      {
        list: [
          "You're responsible for code you write or run in Orbis, for commands you approve, and for changes made by the coding agent that you keep. Review changes before you rely on them. You can revert agent changes in the Changes panel.",
          "Code runs on isolated computers with limited network access. While a project's computer is on, its live preview has a public web address, so don't put passwords, keys or other secrets in your projects.",
          "When you connect an app, you authorise Orbis to access it with the permissions you grant, and that app's own terms apply. Actions in an app happen only after you confirm them. Pushing to GitHub happens only when you choose to, and creates a new branch.",
        ],
      },
    ],
  },
  {
    id: "plans",
    title: "Plans, limits and payment",
    blocks: [
      {
        list: [
          "The Free plan costs nothing and has usage limits. Paid plans (Pro and Max) and their prices are shown on the [Pricing](/pricing) page in US dollars, plus any tax that applies. Paid plans aren't on sale yet; these terms apply once they are.",
          "Paid plans are billed in advance, monthly or yearly, through our payment provider, Stripe, and renew automatically until you cancel. You can cancel at any time: you keep your plan until the end of the period you've paid for and won't be charged again.",
          "Upgrades are charged pro rata straight away. Downgrades are credited against your next invoice.",
          "Each plan's limits are described on the Pricing page and shown in the app. No plan is unlimited. We may change plans, prices or limits for future billing periods, with advance notice, but not for a period you've already paid for.",
          "If you're a consumer in the UK, you can cancel a new subscription within 14 days and get a refund. If you start using a paid plan during those 14 days, we may deduct an amount for what you've used. Apart from this, and where the law requires otherwise, we don't refund part-used billing periods.",
        ],
      },
    ],
  },
  {
    id: "ending",
    title: "Suspension and ending",
    blocks: [
      `You can stop using Orbis at any time. To have your account deleted, email ${mail}.`,
      "We may suspend or close an account if it seriously or repeatedly breaks these terms, if the law requires it, or to protect Orbis, its users or others. Where it's reasonable, we'll warn you first and explain why. If we close Orbis altogether, we'll give at least 30 days' notice and refund any prepaid fees for the time after it closes.",
    ],
  },
  {
    id: "liability",
    title: "Our responsibility to you",
    blocks: [
      "Nothing in these terms limits our liability for death or personal injury caused by our negligence, for fraud, or for anything else the law doesn't allow us to limit.",
      "**If you're a consumer:** we're responsible for loss or damage you suffer that is a foreseeable result of our breaking these terms or failing to use reasonable care and skill. We're not responsible for loss that wasn't foreseeable, or for business losses. Your legal rights as a consumer are not affected.",
      "**If you use Orbis for business:** Orbis is provided “as is”, and we're not liable for indirect or consequential loss, or for loss of profit, revenue, data or goodwill. Our total liability to you is limited to the greater of £100 and the amount you paid us in the 12 months before the claim.",
    ],
  },
  {
    id: "changes",
    title: "Changes to these terms",
    blocks: [
      "We may update these terms, for example when Orbis changes or the law does. We'll post the new version here with a new date, and tell you in advance in Orbis or by email if a change significantly affects you. If you don't agree with the new terms, you can stop using Orbis and ask us to delete your account.",
    ],
  },
  {
    id: "law",
    title: "Law and disputes",
    blocks: [
      "These terms are governed by the law of England and Wales, and disputes go to the courts of England and Wales. If you live in Scotland or Northern Ireland, you can also bring proceedings there. If you're a consumer living elsewhere, you keep any protections your local law gives you that can't be excluded.",
      `If something goes wrong, please contact us first at ${mail} — most problems can be sorted out quickly.`,
    ],
  },
  {
    id: "contact",
    title: "Contact",
    blocks: [`${mail}`],
  },
];
