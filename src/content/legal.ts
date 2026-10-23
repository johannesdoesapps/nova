/**
 * Privacy Policy and Terms of Service. Written from how Orbis actually works
 * (what it stores, who receives what); keep them in step with the product.
 * Change `updated` whenever the meaning changes.
 *
 * Text uses a tiny markup: [label](href) for links. A block is a paragraph
 * (string) or a bulleted list ({ list: [...] }).
 */

import { LEGAL } from "./legal-meta";

export { LEGAL };

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
    title: "Who we are and what this policy covers",
    blocks: [
      `Orbis (tryorbis.app) is an AI workspace run from the ${LEGAL.country} by ${OPERATOR}${LEGAL.address ? `, ${LEGAL.address}` : ""} (“Orbis”, “we”, “us”). We decide how and why your personal data is used, which makes us the “controller” under the UK General Data Protection Regulation (UK GDPR) and the Data Protection Act 2018.`,
      "This policy covers personal data we process when you visit tryorbis.app, create an account and use Orbis. It doesn't cover the services of AI providers or apps you connect, which have their own policies.",
      `Contact us about your data at ${mail}. We haven't appointed a Data Protection Officer; that address reaches the person responsible for data protection at Orbis.`,
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
          "We don't use your content to train AI models, we don't sell your data, and we don't show ads.",
          "Only strictly necessary cookies are used. There are no analytics or advertising cookies; we count visits anonymously with Vercel Web Analytics, which doesn't use cookies, and you can turn that off. Every cookie is listed in the [Cookie Policy](/cookies).",
          "You can delete conversations and projects at any time, disconnect apps, and ask us for a copy of your data or to delete your account.",
        ],
      },
    ],
  },
  {
    id: "collect",
    title: "Personal data we collect",
    blocks: [
      "**Data you give us**",
      {
        list: [
          "**Account details:** your email address, the name you give (optional) and your password, which our sign-in provider stores only as a secure hash.",
          "**Your content:** your messages and the AI's replies, conversation titles and cited sources. For files you attach, we keep only the file names: the contents are sent to the AI model to answer you but aren't stored by Orbis. Also agents, missions, Council and Arena sessions, projects and notes you create; code projects and their files; and for each coding agent run, your request, an activity log of what it read, ran and changed (including command output), and each changed file's content before and after the run.",
          "**Security Team data:** websites you register, scan results and findings, including short excerpts of evidence.",
          "**Communications:** what you send us when you email us, such as support questions or requests about your data.",
          "**Acceptances:** when you accepted our Terms of Service and this policy, and which version.",
        ],
      },
      "**Data created when you use Orbis**",
      {
        list: [
          "**Usage records:** for each AI request, the model, number of tokens, estimated cost, time taken and what it was for — not the text of your prompt or the reply. Records made up to 22 October 2026 also hold the first part of the prompt and reply (up to 4,000 and 8,000 characters); nothing in Orbis reads them, and they're deleted with your account. For code you run from a chat reply, only the language and exit code. For workspace computers, the minutes used.",
          "**Technical data:** your IP address, browser and device details, processed by our hosting and sign-in providers in their logs to deliver the service and keep it secure. If you use Orbis without an account, your IP address is used briefly in memory to apply rate limits; it isn't stored in our database.",
          "**Feedback and usage events:** with an account, the ratings you choose to give a result (such as helpful, incorrect or incomplete) and any note you write with one; and a few events about how Orbis is used, such as a template started or finished, a check or comparison completed, a usage limit reached, or which kind of command palette command you used. Events carry short labels from a fixed list (such as the template's name), never what you type. You can turn usage events off in Settings → Privacy and data.",
          "**On your device:** without an account, your conversations are kept only in your browser's local storage. Preferences (theme, sidebar, last model, saved prompts, your own template versions and, without an account, the thumbs-up/down you give replies) are kept in your browser only. The [Cookie Policy](/cookies) lists everything stored there.",
          "**Memory:** facts you ask Orbis to remember (in Settings → Memory, or by starting a message with “Remember that…”). They're given to the AI model as background for your replies while memory is on, and you can delete any of them, or turn memory off, at any time.",
          "**Images you create:** your description is sent to OpenAI to make the image. Orbis doesn't store the image or the description; the usage record notes only that an image was made and its cost.",
          "**Emails we send you:** a record that a service email (such as a welcome email, a usage warning or a payment problem) was sent, so it isn't sent twice.",
          "**Teams:** if you're in a team, the team's members can see your email address and role in the team; the owner can also see pending invitations. They can't see your chats or other content. An invitation stores the invited email address and a hash of its link code.",
          "**Shared chats:** if you share a chat, we store the link's random code and the time you shared it. Anyone with the link can read the chat's title and messages up to that time; they don't see your name, your other chats or your projects.",
        ],
      },
      "**Data from others**",
      {
        list: [
          "**Sign-in providers:** if you sign in with Google or GitHub, we receive your name, email address and account ID from them.",
          "**Connected apps:** when you connect an app, we store an account label (such as the connected account's email address), the permissions you granted, encrypted access tokens and when the connection was made, checked and last used. When you confirm an action in an app, we log the app, the action, whether it worked and a short summary, but not the message or document content. What Orbis reads from your apps is used to answer you and is saved only as part of that answer and its cited sources.",
          "**Payments:** when paid plans are on sale, Stripe tells us your customer ID, plan, subscription status and billing period, never your card number. If you turn on automatic top-ups, Stripe keeps the card you save for them and we store only Stripe's reference to it, your settings, when you agreed and the wording you agreed to, and each top-up's amount and result. If a payment is disputed with your bank, we record the dispute's reference, amount, reason and status. If you buy extra usage, we record the units, the amount paid and Stripe's reference for the payment, and each time extra usage pays for a request.",
        ],
      },
    ],
  },
  {
    id: "use",
    title: "How we use personal data",
    blocks: [
      {
        list: [
          "To provide Orbis: your account, storing your work, sending your requests to AI models, running code and connecting apps you choose.",
          "To apply plan limits, take payment and keep billing records.",
          "To keep Orbis secure: rate limits, usage caps, preventing fraud and abuse, and investigating misuse.",
          "To support you and send service messages, such as confirming your email, resetting your password, confirming a subscription, warning you when you're close to a usage limit, or telling you a payment failed. We don't send marketing emails.",
          "To understand overall usage — for example, which models are used and what they cost — from aggregated usage records.",
          "To find where Orbis falls short and improve it, from feedback and usage events — for example, how often templates are finished, which answers people mark as incorrect, and how often limits get in the way.",
          "To comply with the law and respond to lawful requests.",
        ],
      },
      "We don't use your conversations, files or code to train AI models, and we don't use them to build advertising profiles. We don't make decisions about you based solely on automated processing that have legal or similarly significant effects.",
    ],
  },
  {
    id: "legal-bases",
    title: "Legal bases",
    blocks: [
      {
        list: [
          "**Contract:** to provide Orbis and the features you use, and to manage your account and plan.",
          "**Legitimate interests:** to keep Orbis secure, prevent abuse, enforce limits, understand overall usage and improve the service. You can object to this processing (see Your rights).",
          "**Legal obligation:** to keep billing and tax records and respond to lawful requests.",
          "**Consent:** where we ask for it. You can withdraw consent at any time.",
        ],
      },
    ],
  },
  {
    id: "recipients",
    title: "Who we share personal data with",
    blocks: [
      "We use these service providers to run Orbis. They process data on our behalf, under their data processing terms:",
      {
        list: [
          "**Supabase** — database and sign-in. Data is stored in the United States (AWS US East).",
          "**Vercel** — website hosting, server functions, the isolated computers that run code, and visit statistics (Vercel Web Analytics). United States.",
          "**Anthropic** (Claude models) and **OpenAI** (GPT models) — receive your message, the earlier messages of that conversation, the contents of files you attach, the facts in your memory (while memory is on), and, for coding agent runs, the parts of your project the agent reads. OpenAI also receives the descriptions of images you create. Under their API terms, data sent through their APIs isn't used to train their models by default; they may keep it for a limited period to monitor abuse.",
          "**Stripe** — payments, once paid plans are on sale.",
          "**Resend** — sends Orbis's service emails (your email address and the message). United States.",
        ],
      },
      "Only Anthropic and OpenAI models are enabled on tryorbis.app today. Orbis can also use Google (Gemini), xAI (Grok), DeepSeek and a web search provider (Tavily or Brave); we'll add any of them to this list before they receive your data.",
      "**Apps you connect** (such as Google Drive, Gmail, Slack, Notion, GitHub or Wikipedia) receive the searches Orbis makes for you and the actions you confirm. Their own privacy policies apply.",
      "**People you share a chat with:** anyone who has a link you created can read that chat as it was when you shared it.",
      "**Package registries** (npm and PyPI) see the download requests your project's computer makes when it installs packages.",
      "**Authorities and others, when required:** we may disclose data if the law requires it, to protect people's safety or rights, or to investigate fraud or security issues.",
      "**Business transfers:** if Orbis is sold, merged or reorganised, data may pass to the new owner, who must keep protecting it as this policy describes.",
      "We don't sell personal data or share it with advertisers.",
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
          "**Feedback and usage events** — while your account exists. Turning usage events off stops new ones being recorded; email us to have past ones deleted.",
          "**Billing records** — as long as tax law requires (usually six years in the UK).",
          "**Connected-app tokens** — until you disconnect the app or delete your account.",
          "**Memory** — until you delete it or your account.",
          "**Records of your acceptances** — while your account exists.",
          "**When you delete your account** — we delete it and the content linked to it within 30 days of your request, except records we must keep by law or to resolve a dispute.",
        ],
      },
    ],
  },
  {
    id: "controls",
    title: "Your choices and data controls",
    blocks: [
      {
        list: [
          "Delete or archive any conversation from the sidebar; delete agents, missions and code projects at any time.",
          "Revert any change the coding agent made, or a single file, from the Changes panel.",
          "Turn each connected app to Auto, “only when I mention it” or Off, or disconnect it entirely.",
          "Use Orbis without an account: your conversations then stay in your browser only.",
          "Share a chat only when you choose to; update the link to include newer messages, or stop sharing and the link stops working straight away.",
          "Turn anonymous visit counts off in Settings → Privacy and data or on the [Cookie Policy](/cookies) page. Your browser's Global Privacy Control or Do Not Track signal does the same.",
          "Clear the preferences Orbis keeps in your browser through your browser's settings.",
          "Turn usage events off in Settings → Privacy and data. Rating a result is always optional.",
          "There's nothing to opt out of for AI training or marketing, because we do neither with your data.",
        ],
      },
    ],
  },
  {
    id: "rights",
    title: "Your rights",
    blocks: [
      "Under UK data protection law you have the right to:",
      {
        list: [
          "get a copy of your personal data (access);",
          "have inaccurate data corrected;",
          "have your data deleted;",
          "restrict how we use it, or object to processing based on our legitimate interests;",
          "receive your data in a portable format;",
          "withdraw consent you've given, at any time.",
        ],
      },
      `To use these rights, email ${mail} from the address on your account. We may ask you to confirm your identity. We'll reply within one month. Deleting your account isn't self-service yet, so this is also how you ask for that.`,
      "If an AI reply in your account contains inaccurate information about you or someone else, tell us. We can't change how the AI models work, but we can delete the reply.",
      "If you're unhappy with how we handle your data, please tell us first. You can also complain to the Information Commissioner's Office: [ico.org.uk](https://ico.org.uk/make-a-complaint/) or 0303 123 1113.",
    ],
  },
  {
    id: "cookies",
    title: "Cookies and storage on your device",
    blocks: [
      "Orbis uses only cookies that are strictly necessary for it to work, so it doesn't ask for cookie consent. The [Cookie Policy](/cookies) lists each cookie and storage item, with how long it lasts:",
      {
        list: [
          "**Sign-in cookies** (from Supabase, names starting with “sb-”) keep you signed in.",
          "**orbis_terms** remembers that you've accepted the current Terms of Service and Privacy Policy, so you aren't asked again on every page.",
          "**Temporary cookies** protect the sign-in to an app you're connecting (orbis_connect, 10 minutes) and carry your acceptance through signing up with Google or GitHub (orbis_terms_pending, 30 minutes).",
        ],
      },
      "Your browser's local storage holds your preferences and, without an account, your conversations. There are no analytics or advertising cookies.",
      "To see how Orbis is used, we count page visits with **Vercel Web Analytics**. For each visit it records the page (with any ids and everything after a “?” removed), the site you came from, and your country, browser, operating system and type of device. It doesn't use cookies or store anything on your device. Visitors are told apart by a code worked out from the request, which Vercel discards after 24 hours, so visits aren't linked to you, your account or your IP address, or followed across days or other websites. When you pick one of the starting options on the first screen (such as “Coding”) or one of its examples, which option it was is counted too — never what you type. You can turn visit counts off for your browser, and nothing is counted if your browser sends a Global Privacy Control or Do Not Track signal.",
    ],
  },
  {
    id: "children",
    title: "Children",
    blocks: [
      `Orbis isn't for children under ${LEGAL.minimumAge}. If you're between ${LEGAL.minimumAge} and 17, you need a parent's or guardian's permission to use it. If we learn that someone under ${LEGAL.minimumAge} has an account, we'll delete it. Parents and guardians can contact us at ${mail}.`,
    ],
  },
  {
    id: "security",
    title: "Security",
    blocks: [
      "Data is sent over HTTPS. Database row-level security means signed-in users can read only their own data. Connected-app tokens are encrypted with a key only our server holds. Code runs on isolated, short-lived computers that hold none of Orbis's own keys. No system is perfectly secure; if a breach affects your personal data, we'll tell you and the ICO as the law requires. More detail is on [Security & data](/security).",
    ],
  },
  {
    id: "links",
    title: "Links to other websites",
    blocks: [
      "Orbis shows links to other websites, for example in cited sources and AI replies. We're not responsible for those websites or how they handle your data; read their privacy policies.",
    ],
  },
  {
    id: "changes",
    title: "Changes to this policy",
    blocks: [
      "We'll post any new version here with a new date. If a change significantly affects how we use your data, we'll tell you in Orbis or by email before it takes effect, and ask you to accept the new version before you continue using Orbis.",
    ],
  },
  {
    id: "contact",
    title: "Contact",
    blocks: [`Email ${mail}. ${LEGAL.operatorName ? `${LEGAL.operatorName}` : "Orbis"} is based in the ${LEGAL.country}.`],
  },
];

export const TERMS: LegalSection[] = [
  {
    id: "who",
    title: "Who we are",
    blocks: [
      `Orbis (tryorbis.app) is an AI workspace provided by ${OPERATOR}${LEGAL.address ? `, ${LEGAL.address}` : ""}, based in the ${LEGAL.country} (“Orbis”, “we”, “us”). These Terms of Service are an agreement between you and us. By creating an account or using Orbis, you agree to them.`,
      "If you use Orbis on behalf of an organisation, you confirm that you're allowed to accept these terms for it, and the section on business use applies.",
    ],
  },
  {
    id: "other-terms",
    title: "Other terms that apply",
    blocks: [
      {
        list: [
          "Our [Privacy Policy](/privacy) explains how we handle personal data, and our [Cookie Policy](/cookies) lists the cookies and browser storage Orbis uses.",
          "The usage rules of the AI providers whose models you use also apply: the [Anthropic Usage Policy](https://www.anthropic.com/legal/aup) and the [OpenAI Usage Policies](https://openai.com/policies/usage-policies/).",
          "Apps you connect to Orbis have their own terms, which apply to your use of them.",
        ],
      },
    ],
  },
  {
    id: "account",
    title: "Registration and access",
    blocks: [
      {
        list: [
          `You must be at least ${LEGAL.minimumAge} years old to use Orbis. If you're under 18, you need permission from a parent or guardian, who agrees to these terms on your behalf.`,
          "Give accurate information when you sign up, and keep it up to date. Keep your password safe: you're responsible for what happens in your account. An account is for one person; don't share it or let others use it.",
          "We'll contact you, and send notices about Orbis or these terms, by email to the address on your account or in Orbis itself.",
        ],
      },
    ],
  },
  {
    id: "using",
    title: "Using Orbis",
    blocks: [
      "You may use Orbis in line with these terms and the law. You must not use Orbis to:",
      {
        list: [
          "break the law, or infringe anyone's intellectual property, privacy or other rights;",
          "create or share sexual content involving minors, or content that threatens, harasses or promotes violence against people;",
          "create malware, attack or gain unauthorised access to systems, or scan or test systems you don't own or have permission to test;",
          "use the code computers for cryptocurrency mining, spam, denial-of-service, proxying traffic, or to get around their network limits;",
          "get around usage limits, plan restrictions or safety measures — for example with several accounts — or resell or share access to Orbis;",
          "copy, scrape, or reverse-engineer Orbis, except where the law allows it, or use it or its output to build a competing service or AI model;",
          "pass off AI output as written by a person where that would mislead someone;",
          "make decisions that have legal or similarly significant effects on a person — such as about employment, credit, housing or legal rights — based on AI output without a person reviewing them.",
        ],
      },
      "**Feedback.** If you send us ideas or feedback about Orbis, we may use them to improve Orbis without any obligation to you.",
    ],
  },
  {
    id: "content",
    title: "Your content",
    blocks: [
      "**Your content belongs to you.** What you put into Orbis (“input”) and what Orbis produces for you (“output”) is your content. You keep your rights in your input and, as between you and us, you own the output, to the extent the law allows.",
      "**What we do with it.** You give us permission to store, process and transmit your content — including sending it to AI providers and to apps you connect — only as needed to run Orbis for you, keep it secure and comply with the law. We don't use your content to train AI models.",
      "**Your responsibility.** You're responsible for your input. You confirm that you have the rights needed to submit it, including files, code and content from apps you connect, and that it doesn't break these terms.",
      "**Sharing.** If you share a chat, anyone with the link can read it as it was when you shared it. Only share what you have the right to share and what doesn't break these terms. You can stop sharing at any time; we may turn off a shared link that breaks these terms.",
      "**Review.** We don't routinely read your content. We may review it when investigating a report of abuse, a security issue or a breach of these terms, or when the law requires it. AI providers apply their own safety systems and may refuse some requests.",
      "**Accuracy.** AI can be wrong, incomplete or out of date, and can produce content that's offensive or that someone else holds rights in. Output isn't professional advice — don't use it instead of a qualified lawyer, doctor, financial adviser or other professional. Check output before you rely on it. Other users may receive output similar to yours.",
    ],
  },
  {
    id: "actions",
    title: "Code, agents and connected apps",
    blocks: [
      {
        list: [
          "The coding agent edits files in your Orbis project and runs commands on that project's isolated computer, within the rules shown in Orbis and the permissions you choose. You're responsible for code you write or run, for commands you approve, and for changes you keep. Review changes before you rely on them; you can revert them in the Changes panel.",
          "While a project's computer is on, its live preview has a public web address, so don't put passwords, keys or other secrets in your projects.",
          "When you connect an app, you authorise Orbis to access it with the permissions you grant. Actions in an app happen only after you confirm them. Pushing to GitHub happens only when you choose to, and creates a new branch.",
        ],
      },
    ],
  },
  {
    id: "ip",
    title: "Our intellectual property",
    blocks: [
      "Orbis, its software, design and content (other than your content) belong to us or our licensors. These terms don't give you any rights in them beyond using Orbis as described here. Don't use the Orbis name or logo in a way that suggests we endorse you without our written permission.",
    ],
  },
  {
    id: "paid",
    title: "Paid plans",
    blocks: [
      {
        list: [
          "The Free plan costs nothing and has usage limits. Paid plans (Pro and Max) and their prices are shown on the [Pricing](/pricing) page in US dollars, plus any tax that applies. Paid plans aren't on sale yet; this section applies once they are.",
          "Paid plans are billed in advance, monthly or yearly, through our payment provider, Stripe, and renew automatically until you cancel. You can cancel at any time: you keep your plan until the end of the period you've paid for and won't be charged again.",
          "Upgrades are charged pro rata straight away. Downgrades are credited against your next invoice.",
          "**Extra usage:** on Pro and Max you can buy packs of extra usage units, when they're on sale, as a one-off payment. They're used only when one of your plan's limits is reached (and only while “Use extra usage automatically” is on), stay in your account while it exists, and can't be exchanged for money. If you cancel your plan, units you haven't used stay available for when you subscribe again.",
          "**Automatic top-ups (optional):** if you turn them on, you authorise us to charge the card you save for them the amount shown, each time your extra usage falls below the level you choose, up to the monthly limit you set. You get a receipt for every charge, and you can change or turn them off at any time on the Usage page. If a charge fails, automatic top-ups turn off and we tell you.",
          "**Team plan:** a team owner buys a number of seats of Pro or Max in one subscription and is responsible for paying for it. Each member gets that plan with their own allowance; allowances aren't shared. The owner can invite and remove members and change the number of seats (pro rata). When the team's subscription ends, members return to the Free plan. The owner can see members' email addresses, not their chats or other content.",
          "Each plan's limits are described on the Pricing page and shown in the app. No plan is unlimited. We'll give you at least 30 days' notice of a price increase or of a reduction in what your plan includes, and it will apply only from your next billing period. If you don't want to continue, you can cancel before then.",
          `**14-day cancellation (UK consumers):** you can cancel a new paid subscription within 14 days of buying it and get a refund, by emailing ${mail}. If you started using the paid plan during those 14 days, we may deduct an amount for what you used. Apart from this, and where the law requires otherwise, we don't refund part-used billing periods.`,
        ],
      },
    ],
  },
  {
    id: "third-party",
    title: "Third-party services and links",
    blocks: [
      "Orbis works with services we don't control: AI providers, apps you connect, package registries your code downloads from, and websites linked in replies. We're not responsible for those services, their content or their availability, and your use of them is subject to their own terms.",
    ],
  },
  {
    id: "ending",
    title: "Suspension and termination",
    blocks: [
      `You can stop using Orbis at any time. To have your account deleted, email ${mail}.`,
      "We may suspend or close an account if it seriously or repeatedly breaks these terms, if the law requires it, or to protect Orbis, its users or others from harm. Where it's reasonable, we'll warn you first and explain why, and you can reply to contest the decision.",
      "If we close Orbis altogether, we'll give at least 30 days' notice so you can copy your content, and refund any prepaid fees for the time after it closes.",
    ],
  },
  {
    id: "changes",
    title: "Changes to Orbis and these terms",
    blocks: [
      "Orbis is developing quickly. Features marked Beta or Private preview may change, have limits or be withdrawn. We work to keep Orbis available and reliable but can't promise it will always be available or error-free.",
      "We may update these terms, for example when Orbis changes or the law does. We'll post the new version here with a new date. If a change significantly affects you, we'll tell you at least 30 days in advance and ask you to accept the new terms before you continue using Orbis. If you don't agree, you can stop using Orbis and ask us to delete your account; if you're on a paid plan, we'll refund the unused part of it.",
    ],
  },
  {
    id: "liability",
    title: "Our responsibility to you",
    blocks: [
      "We provide Orbis with reasonable care and skill. If you're a consumer, you have legal rights in relation to services that aren't as described or not provided with reasonable care and skill; nothing in these terms affects those rights.",
      "Nothing in these terms limits our liability for death or personal injury caused by our negligence, for fraud, or for anything else the law doesn't allow us to limit.",
      "If you're a consumer, we're responsible for loss or damage you suffer that is a foreseeable result of our breaking these terms or failing to use reasonable care and skill. We're not responsible for loss that wasn't foreseeable. Orbis is for personal use: we're not liable to consumers for loss of profit, business or business opportunity.",
    ],
  },
  {
    id: "business",
    title: "Business use",
    blocks: [
      "If you use Orbis for business or on behalf of an organisation:",
      {
        list: [
          "Orbis is provided “as is”, and to the extent the law allows we exclude warranties not set out in these terms.",
          "We're not liable for indirect or consequential loss, or for loss of profit, revenue, data or goodwill. Our total liability to you is limited to the greater of £100 and the amount you paid us in the 12 months before the claim.",
          "You'll compensate us for claims by others arising from your content or your breach of these terms.",
        ],
      },
    ],
  },
  {
    id: "copyright",
    title: "Copyright complaints",
    blocks: [
      `If you believe content in Orbis infringes your copyright, email ${mail} with: a description of the work; where the content appears; your name and contact details; a statement that you believe in good faith the use isn't authorised; and a statement that your notice is accurate and that you own the rights or are authorised to act for the owner. We may close the accounts of users who repeatedly infringe.`,
    ],
  },
  {
    id: "disputes",
    title: "Disputes and governing law",
    blocks: [
      `If something goes wrong, please contact us first at ${mail} — most problems can be sorted out quickly.`,
      "These terms are governed by the law of England and Wales. You can bring proceedings in the courts of England and Wales, or, if you live in Scotland or Northern Ireland, in the courts there. If you're a consumer living elsewhere, you keep the protections and the right to go to court that your local law gives you. There is no arbitration clause: disputes go to the courts.",
    ],
  },
  {
    id: "general",
    title: "General terms",
    blocks: [
      {
        list: [
          "**Assignment:** you may not transfer your rights or obligations under these terms to someone else. We may transfer ours to another organisation, for example if Orbis is sold, as long as this doesn't reduce your rights.",
          "**Sanctions and export:** you may not use Orbis if you're subject to UK, US or UN sanctions, or in a way that breaks export control laws.",
          "**Severability:** if a court finds part of these terms unenforceable, the rest stays in force.",
          "**No waiver:** if we don't enforce a term straight away, we can still enforce it later.",
          "**Entire agreement:** these terms, together with the policies they mention, are the whole agreement between you and us about Orbis.",
        ],
      },
    ],
  },
  {
    id: "contact",
    title: "Contact",
    blocks: [`Email ${mail}.`],
  },
];

/**
 * Cookie Policy: every cookie and browser-storage item Orbis uses, from the
 * code. Keep it in step: a new cookie or storage key belongs here.
 */
export const COOKIES: LegalSection[] = [
  {
    id: "short",
    title: "The short version",
    blocks: [
      {
        list: [
          "Orbis uses only the cookies it needs to sign you in and keep the site secure. There are no advertising or tracking cookies, and none from analytics.",
          "Your browser's local storage keeps your settings and, if you use Orbis without an account, your conversations. It stays on your device.",
          "Page visits are counted anonymously, without cookies. You can turn that off for your browser below, and Orbis respects your browser's Global Privacy Control and Do Not Track signals.",
          "Because Orbis only stores what it needs to work or what you ask it to keep, it doesn't show a cookie banner.",
        ],
      },
    ],
  },
  {
    id: "cookies",
    title: "Cookies Orbis sets",
    blocks: [
      "All of these are first-party cookies (set by tryorbis.app), strictly necessary, and never used for advertising or to follow you to other websites.",
      {
        list: [
          "**sb-…-auth-token** (Supabase) — keeps you signed in. Set when you sign in; removed when you sign out, and otherwise kept for up to 400 days while it's refreshed. A related **sb-…-code-verifier** cookie protects signing in with Google or GitHub and is removed once you're signed in.",
          "**orbis_terms** — remembers which version of the Terms of Service and Privacy Policy you accepted, so you aren't asked on every page. Up to 1 year.",
          "**orbis_terms_pending** — carries your acceptance through signing up with Google or GitHub. 30 minutes, removed when sign-up finishes.",
          "**orbis_connect** — protects the sign-in to an app you're connecting, so the connection can't be hijacked. 10 minutes, only on connection pages.",
          "**orbis_guest** — only if you use AI Lab or Signal Radar without an account: a random code that keeps your guest work together. 180 days.",
        ],
      },
    ],
  },
  {
    id: "storage",
    title: "Storage in your browser",
    blocks: [
      "Orbis also uses your browser's local storage and session storage. These aren't cookies: they aren't sent to our servers with each request, and they stay on your device unless a feature uses them — for example, without an account, your earlier messages are sent with a new message so the AI can follow the conversation.",
      {
        list: [
          "**Display settings:** theme, sidebar and panel sizes, and which menus you left open.",
          "**Choices you make:** the model you last picked for Chat and for Code, a copy of the model list so the model menu shows straight away, and whether this browser's visits are counted.",
          "**Your work without an account:** conversations, agents and their chats, the thumbs-up or thumbs-down you give replies, saved prompts, your own template versions, and results saved by the research tools (Trials, Benchmarks, Arena and claim reports).",
          "**Short hand-overs between pages** (session storage, cleared when you close the tab): a website request passed from the Code start screen to its project, and text passed to Verify.",
          "**Getting started:** whether you've seen the welcome and the one-time Code tip, and the last chat or project you had open, so Orbis can take you back to it.",
        ],
      },
      "With an account, your conversations and projects are stored with your account instead (see the [Privacy Policy](/privacy)).",
    ],
  },
  {
    id: "analytics",
    title: "Anonymous visit counts",
    blocks: [
      "To see which pages are used, Orbis counts visits with **Vercel Web Analytics**. For each visit it records the page, the site you came from, and your country, browser, operating system and type of device.",
      {
        list: [
          "It uses no cookies and stores nothing on your device.",
          "Page addresses are cleaned before they're counted: everything after a “?” or “#” is removed, ids are replaced with [id], and the code in a shared link is replaced with [link].",
          "Visitors are told apart by a code worked out from the request, which Vercel discards after 24 hours, so visits aren't linked to you, your account or your IP address, or followed across days or other websites.",
          "When you pick one of the starting options on the first screen (such as “Coding”), which option it was is counted too — never what you type.",
          "Nothing is counted from your browser if you turn visit counts off (below, or in Settings → Privacy and data), or if your browser sends a Global Privacy Control or Do Not Track signal.",
        ],
      },
    ],
  },
  {
    id: "consent",
    title: "Why there's no cookie banner",
    blocks: [
      "UK law (the Privacy and Electronic Communications Regulations) requires consent before a site stores or reads information on your device, except where that's strictly necessary to provide a service you asked for. Orbis's cookies are needed for signing in, security and the sign-up you started; its browser storage holds things you chose or created. Visit counts store nothing on your device, and you can turn them off. So Orbis doesn't ask for cookie consent.",
      "If we ever add a cookie or storage item that isn't strictly necessary, we'll ask for your consent first and list it here.",
    ],
  },
  {
    id: "control",
    title: "How to control them",
    blocks: [
      {
        list: [
          "**Signing out** removes the sign-in cookies.",
          "**Your browser's settings** let you see and delete cookies and site data, or block them. If you block cookies for tryorbis.app, you won't be able to sign in.",
          "**Clearing site data** for tryorbis.app removes everything in local storage too. Without an account, that includes your conversations: download any you want to keep first (each chat's menu has Download).",
          "**Visit counts** can be turned off below or in Settings → Privacy and data.",
        ],
      },
    ],
  },
  {
    id: "others",
    title: "Other websites",
    blocks: [
      "When you leave Orbis — to sign in with Google or GitHub, connect an app, pay with Stripe once paid plans are on sale, or open a link in a reply — those websites may set their own cookies under their own policies.",
    ],
  },
  {
    id: "contact",
    title: "Changes and contact",
    blocks: [`We'll update this page when the cookies or storage Orbis uses change. Questions: ${mail}.`],
  },
];
